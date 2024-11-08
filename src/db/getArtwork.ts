import {Track} from 'src/entities';
import LocalDatabase from 'src/localdb';
import {fetchFile} from 'src/nfs';
import RemoteDatabase, {MenuTarget, Query} from 'src/remotedb';
import {Device, DeviceID, MediaSlot, TrackType} from 'src/types';

export interface Options {
	/**
	 * The device to query the track artwork off of
	 */
	deviceId: DeviceID;
	/**
	 * The media slot the track is present in
	 */
	trackSlot: MediaSlot;
	/**
	 * The type of track we are querying artwork for
	 */
	trackType: TrackType;
	/**
	 * The track to lookup artwork for
	 */
	track: Track;
}

export async function viaRemote(remote: RemoteDatabase, opts: Required<Options>) {
	const {deviceId, trackSlot, trackType, track} = opts;

	const conn = await remote.get(deviceId);
	if (conn === null) {
		return null;
	}

	if (track.artwork === null) {
		return null;
	}

	const queryDescriptor = {
		trackSlot,
		trackType,
		menuTarget: MenuTarget.Main,
	};

	return conn.query({
		queryDescriptor,
		query: Query.GetArtwork,
		args: {artworkId: track.artwork.id},
	});
}

export async function viaLocal(local: LocalDatabase, device: Device, opts: Required<Options>) {
	const {deviceId, trackSlot, track} = opts;

	if (trackSlot !== MediaSlot.USB && trackSlot !== MediaSlot.SD) {
		throw new Error('Expected USB or SD slot for remote database query');
	}

	const conn = await local.get(deviceId, trackSlot);
	if (conn === null) {
		return null;
	}

	if (track.artwork === null || track.artwork.path === undefined) {
		return null;
	}

	try {
		return fetchFile({device, slot: trackSlot, path: track.artwork.path});
	} catch (error) {
		return null;
	}
}
