import {FetchProgress} from 'src/types.ts';

import {RpcConnection, RpcProgram} from './rpc.ts';
import {flattenLinkedList} from './utils.ts';
import {mount, nfs, portmap} from './xdr.ts';

/**
 * How many bytes of a file should we read at once.
 */
const READ_SIZE = 2048;

interface Program {
	id: number;
	version: number;
}

/**
 * Queries for the listening port of a RPC program
 */
export async function makeProgramClient(conn: RpcConnection, program: Program) {
	const getPortData = new portmap.GetPort({
		program: program.id,
		version: program.version,
		protocol: 17, // UDP protocol
		port: 0,
	});

	const data = await conn.call({
		port: 111,
		program: portmap.Program,
		version: portmap.Version,
		procedure: portmap.Procedure.getPort().value,
		data: getPortData.toXDR(),
	});

	const port = data.readInt32BE();

	return new RpcProgram(conn, program.id, program.version, port);
}

/**
 * Export represents a NFS export on a remote system
 */
interface Export {
	/**
	 * The name of the exported filesystem
	 */
	filesystem: string;
	/**
	 * The groups allowed to mount this filesystem
	 */
	groups: string[];
}

/**
 * Attributes a remote file
 */
export interface FileInfo {
	handle: Buffer;
	name: string;
	size: number;
	type: 'null' | 'regular' | 'directory' | 'block' | 'char' | 'link';
}

/**
 * Request a list of export entries.
 */
export async function getExports(conn: RpcProgram) {
	const data = await conn.call({
		procedure: mount.Procedure.export().value,
		data: Buffer.alloc(0),
	});

	const entry = mount.ExportListResponse.fromXDR(data).next();
	if (entry === undefined) {
		return [];
	}

	const exports = flattenLinkedList(entry).map((entry: any) => ({
		filesystem: entry.filesystem(),
		groups: flattenLinkedList(entry.groups()).map((g: any) => g.name().toString()),
	}));

	return exports as Export[];
}

/**
 * Mount the specified export, returning the file handle.
 */
export async function mountFilesystem(conn: RpcProgram, {filesystem}: Export) {
	const resp = await conn.call({
		procedure: mount.Procedure.mount().value,
		data: new mount.MountRequest({filesystem}).toXDR(),
	});

	const fileHandleResp = mount.FHStatus.fromXDR(resp);
	if (fileHandleResp.arm() !== 'success') {
		throw new Error('Failed to mount filesystem');
	}

	return fileHandleResp.success() as Buffer;
}

/**
 * Lookup a file within the directory of the provided file handle, returning
 * the FileInfo object if the file can be located.
 */
export async function lookupFile(conn: RpcProgram, handle: Buffer, filename: string) {
	const resp = await conn.call({
		procedure: nfs.Procedure.lookup().value,
		data: new nfs.DirectoryOpArgs({handle, filename}).toXDR(),
	});

	const fileResp = nfs.DirectoryOpResponse.fromXDR(resp);
	if (fileResp.arm() !== 'success') {
		throw new Error(`Failed file lookup of ${filename}`);
	}

	const fileHandle = fileResp.success().handle();
	const attributes = fileResp.success().attributes();

	const info: FileInfo = {
		name: filename,
		handle: fileHandle,
		size: attributes.size(),
		type: attributes.type().name,
	};

	return info;
}

/**
 * Lookup the absolute path to a file, given the root file handle and path,
 */
export async function lookupPath(conn: RpcProgram, rootHandle: Buffer, filepath: string) {
	// There are times when the path includes a leading slash, sanitize that
	const pathParts = filepath.replace(/^\//, '').split('/');

	let handle: Buffer = rootHandle;
	let info: FileInfo;

	while (pathParts.length !== 0) {
		const filename = pathParts.shift()!;
		const fileInfo = await lookupFile(conn, handle, filename);

		info = fileInfo;
		handle = info.handle;
	}

	// We can gaurentee this will be set since we will have failed to lookup the
	// file above
	return info!;
}

/**
 * Fetch the specified file the remote NFS server. This will read the entire
 * file into memory.
 */
export async function fetchFile(
	conn: RpcProgram,
	file: FileInfo,
	onProgress?: (progress: FetchProgress) => void,
) {
	const {handle, size} = file;
	const data = Buffer.alloc(size);

	let bytesRead = 0;

	while (bytesRead < size) {
		const readArgs = new nfs.ReadArgs({
			handle,
			offset: bytesRead,
			count: READ_SIZE,
			totalCount: 0,
		});

		const resp = await conn.call({
			procedure: nfs.Procedure.read().value,
			data: readArgs.toXDR(),
		});

		const dataResp = nfs.ReadResponse.fromXDR(resp);
		if (dataResp.arm() !== 'success') {
			throw new Error(`Failed to read file at offset ${bytesRead} / ${size}`);
		}

		const buffer = dataResp.success().data();

		data.set(buffer, bytesRead);
		bytesRead += buffer.length;

		onProgress?.({read: bytesRead, total: size});
	}

	return data;
}
