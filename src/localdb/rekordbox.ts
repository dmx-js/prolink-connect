import * as KS from 'kaitai-struct';

import {
	Album,
	Artist,
	Artwork,
	Color,
	EntityFK,
	Genre,
	Key,
	Label,
	Playlist,
	PlaylistEntry,
	Track,
} from 'src/entities.ts';
import {MetadataORM, Table} from 'src/localdb/orm.ts';
import {makeCueLoopEntry} from 'src/localdb/utils.ts';
import {BeatGrid, CueAndLoop, HotcueButton, WaveformHD} from 'src/types.ts';
import {convertWaveformHDData} from 'src/utils/converters.ts';
import * as kaitai from './kaitai/index.ts';

const {RekordboxAnlz, RekordboxPdb} = kaitai;
const {KaitaiStream} = KS;

// NOTE: Kaitai doesn't currently have a good typescript exporter, so we will
//       be making liberal usage of any in these utilities. We still guarantee
//       a fully typed public interface of this module.

/**
 * The provided function should resolve ANLZ files into buffers. Typically
 * you would just read the file, but in the case of the prolink network, this
 * would handle loading the file over NFS.
 */
type AnlzResolver = (path: string) => Promise<Buffer>;

/**
 * Data returned from loading DAT anlz files
 */
interface AnlzResponseDAT {
	/**
	 * Embedded beat grid information
	 */
	beatGrid: BeatGrid | null;
	/**
	 * Embedded cue and loop information
	 */
	cueAndLoops: CueAndLoop[] | null;
}

/**
 * Data returned from loading EXT anlz files
 */
interface AnlzResponseEXT {
	/**
	 * HD Waveform information
	 */
	waveformHd: WaveformHD | null;
}

interface AnlzResponse {
	DAT: AnlzResponseDAT;
	EXT: AnlzResponseEXT;
}

/**
 * Details about the current state of the hydtration task
 */
export interface HydrationProgress {
	/**
	 * The specific table that progress is being reported for
	 */
	table: string;
	/**
	 * The total progress steps for this table
	 */
	total: number;
	/**
	 * The completed number of progress steps
	 */
	complete: number;
}

/**
 * Options to hydrate the database
 */
interface Options {
	/**
	 * The metadata ORM of which the tables will be hydrated
	 */
	orm: MetadataORM;
	/**
	 * This buffer should contain the Rekordbox pdb file contents. It will be
	 * used to do the hydration
	 */
	pdbData: Buffer;
	/**
	 * For larger music collections, it may take some time to load everything,
	 * especially when limited by IO. When hydration progresses this function
	 * will be called.
	 */
	onProgress?: (progress: HydrationProgress) => void;
}

/**
 * Given a rekordbox pdb file contents. This function will hydrate the provided
 * database with all entities from the Rekordbox database. This includes all
 * track metadata, including analyzed metadata (such as beatgrids and waveforms).
 */
export async function hydrateDatabase({pdbData, ...options}: Options) {
	const hydrator = new RekordboxHydrator(options);
	await hydrator.hydrateFromPdb(pdbData);
}

/**
 * Loads the ANLZ data of a Track entity from the analyzePath.
 */
export async function loadAnlz<T extends keyof AnlzResponse>(
	track: Track,
	type: T,
	anlzResolver: AnlzResolver,
): Promise<AnlzResponse[T]> {
	const path = `${track.analyzePath}.${type}`;
	const anlzData = await anlzResolver(path);

	const stream = new KaitaiStream(anlzData);
	const anlz = new RekordboxAnlz(stream);

	const result = {} as AnlzResponse[T];
	const resultDat = result as AnlzResponseDAT;
	const resultExt = result as AnlzResponseEXT;

	for (const section of anlz.sections) {
		if (section.fourcc === SectionTags.BEAT_GRID) {
			resultDat.beatGrid = makeBeatGrid(section);
			continue;
		}
		if (section.fourcc === SectionTags.CUES) {
			resultDat.cueAndLoops = makeCueAndLoop(section);
			continue;
		}
		if (section.fourcc === SectionTags.WAVE_COLOR_SCROLL) {
			resultExt.waveformHd = makeWaveformHd(section);
			continue;
		}

		// TODO: The following sections haven't yet been extracted into the local
		//       database.
		//
		// [SectionTags.CUES_2]: null,             <- In the EXT file
		// [SectionTags.SONG_STRUCTURE]: null,     <- In the EXT file
		// [SectionTags.WAVE_PREVIEW]: null,
		// [SectionTags.WAVE_SCROLL]: null,
		// [SectionTags.WAVE_COLOR_PREVIEW]: null, <- In the EXT file
	}

	return result;
}

/**
 * This service provides utilities for translating rekordbox database (pdb_ and
 * analysis (ANLZ) files into the common entity types used in this library.
 */
class RekordboxHydrator {
	#orm: MetadataORM;
	#onProgress: (progress: HydrationProgress) => void;

	constructor({orm, onProgress}: Omit<Options, 'pdbData'>) {
		this.#orm = orm;
		this.#onProgress = onProgress ?? (() => null);
	}

	/**
	 * Extract entries from a rekordbox pdb file and hydrate the passed database
	 * connection with entities derived from the rekordbox entries.
	 */
	async hydrateFromPdb(pdbData: Buffer) {
		const stream = new KaitaiStream(pdbData);
		const db = new RekordboxPdb(stream);

		await Promise.all(db.tables.map((table: any) => this.hydrateFromTable(table)));
	}

	/**
	 * Hydrate the database with entities from the provided RekordboxPdb table.
	 * See pdbEntityCreators for how tables are mapped into database entities.
	 */
	async hydrateFromTable(table: any) {
		const tableName = pdbTables[table.type];
		const createObject = pdbEntityCreators[table.type];

		if (createObject === undefined) {
			return;
		}

		let totalSaved = 0;
		let totalItems = 0;

		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		for (const _ of tableRows(table)) {
			totalItems++;
		}

		for (const row of tableRows(table)) {
			this.#orm.insertEntity(tableName, createObject(row));
			this.#onProgress({complete: ++totalSaved, table: tableName, total: totalItems});

			// Allow additional tasks to occur during hydration
			await new Promise(r => setTimeout(r, 0));
		}
	}
}

/**
 * Utility generator that pages through a table and yields every present row.
 * This flattens the concept of rowGroups and refs.
 */
function* tableRows(table: any) {
	const {firstPage, lastPage} = table;

	let pageRef = firstPage;
	do {
		const page = pageRef.body;

		// Adjust our page ref for the next iteration. We do this early in our loop
		// so we can break without having to remember to update for the next iter.
		pageRef = page.nextPage;

		// Ignore non-data pages. Not sure what these are for?
		if (!page.isDataPage) {
			continue;
		}

		const rows = page.rowGroups
			.map((group: any) => group.rows)
			.flat()
			.filter((row: any) => row.present);

		for (const row of rows) {
			yield row.body;
		}
	} while (pageRef.index <= lastPage.index);
}

interface IdAndNameEntity {
	id: number;
	name: string;
}

const ensureDate = (date: Date) =>
	date instanceof Date && !isNaN(date.valueOf()) ? date : undefined;

/**
 * Utility to create a hydrator that hydrates the provided entity with the id
 * and name properties from the row.
 */
const makeIdNameHydrator =
	<T extends IdAndNameEntity>() =>
	(row: any) =>
		({
			id: row.id,
			name: row.name.body.text ?? '',
		}) as T;

/**
 * Translates a pdb track row entry to a {@link Track} entity.
 */
function createTrack(trackRow: any) {
	const analyzePath: string | undefined = trackRow.analyzePath.body.text;

	const track: Track<EntityFK.WithFKs> = {
		id: trackRow.id,
		title: trackRow.title.body.text,
		trackNumber: trackRow.trackNumber,
		discNumber: trackRow.discNumber,
		duration: trackRow.duration,
		sampleRate: trackRow.sampleRate,
		sampleDepth: trackRow.sampleDepth,
		bitrate: trackRow.bitrate,
		tempo: trackRow.tempo / 100,
		playCount: trackRow.playCount,
		year: trackRow.year,
		rating: trackRow.rating,
		mixName: trackRow.mixName.body.text,
		comment: trackRow.comment.body.text,
		autoloadHotcues: trackRow.autoloadHotcues.body.text === 'ON',
		kuvoPublic: trackRow.kuvoPublic.body.text === 'ON',
		filePath: trackRow.filePath.body.text,
		fileName: trackRow.filename.body.text,
		fileSize: trackRow.fileSize,
		releaseDate: trackRow.releaseDate.body.text,
		analyzeDate: ensureDate(new Date(trackRow.analyzeDate.body.text)),
		dateAdded: ensureDate(new Date(trackRow.dateAdded.body.text)),

		// The analyze file comes in 3 forms
		//
		//  1. A `DAT` file, which is missing some extended information, for the older
		//     Pioneer equipment (likely due to memory constraints).
		//
		//  2. A `EXT` file which includes colored waveforms and other extended data.
		//
		//  3. A `EX2` file -- currently unknown
		//
		// We noramlize this path by trimming the DAT extension off. Later we will
		// try and read whatever is available.
		analyzePath: analyzePath?.substring(0, analyzePath.length - 4),

		artworkId: trackRow.artworkId || null,
		artistId: trackRow.artistId || null,
		originalArtistId: trackRow.originalArtistId || null,
		remixerId: trackRow.remixerId || null,
		composerId: trackRow.composerId || null,
		albumId: trackRow.albumId || null,
		labelId: trackRow.labelId || null,
		genreId: trackRow.genreId || null,
		colorId: trackRow.colorId || null,
		keyId: trackRow.keyId || null,

		// NOTE: There are a few additional columns that will be hydrated through
		// the analyze files (given the analyzePath) which we do not assign here.
		beatGrid: null,
		cueAndLoops: null,
		waveformHd: null,
	};

	return track;
}

/**
 * Translates a pdb playlist row entry into a {@link Playlist} entity.
 */
function createPlaylist(playlistRow: any) {
	const playlist: Playlist = {
		id: playlistRow.id,
		name: playlistRow.name.body.text,
		isFolder: playlistRow.rawIsFolder !== 0,
		parentId: playlistRow.parentId || null,
	};

	return playlist;
}

/**
 * Translates a pdb playlist track entry into a {@link PlaylistTrack} entity.
 */
function createPlaylistEntry(playlistTrackRow: any) {
	const entry: PlaylistEntry<EntityFK.WithFKs> = {
		id: playlistTrackRow.id,
		sortIndex: playlistTrackRow.entryIndex,
		playlistId: playlistTrackRow.playlistId,
		trackId: playlistTrackRow.trackId,
	};

	return entry;
}

/**
 * Translates a pdb artwork entry into a {@link Artwork} entity.
 */
function createArtworkEntry(artworkRow: any) {
	const art: Artwork = {
		id: artworkRow.id,
		path: artworkRow.path.body.text,
	};

	return art;
}

/**
 * Fill beatgrid data from the ANLZ section
 */
function makeBeatGrid(data: any) {
	return data.body.beats.map((beat: any) => ({
		offset: beat.time,
		bpm: beat.tempo / 100,
		count: beat.beatNumber,
	}));
}

/**
 * Fill cue and loop data from the ANLZ section
 */
function makeCueAndLoop(data: any) {
	return data.body.cues.map((entry: any) => {
		// Cues with the status 0 are likely leftovers that were removed

		const button = entry.hotCue === 0 ? false : (entry.type as HotcueButton);
		const isCue = entry.type === 0x01;
		const isLoop = entry.type === 0x02;

		// NOTE: Unlike the remotedb, these entries are already in milliseconds.
		const offset = entry.time;
		const length = entry.loopTime - offset;

		return makeCueLoopEntry(isCue, isLoop, offset, length, button);
	});
}

/**
 * Fill waveform HD data from the ANLZ section
 */
function makeWaveformHd(data: any) {
	return convertWaveformHDData(Buffer.from(data.body.entries));
}

const {PageType} = RekordboxPdb;
const {SectionTags} = RekordboxAnlz;

/**
 * Maps rekordbox pdb table types to orm table names.
 */
const pdbTables = {
	[PageType.TRACKS]: Table.Track,
	[PageType.ARTISTS]: Table.Artist,
	[PageType.GENRES]: Table.Genre,
	[PageType.ALBUMS]: Table.Album,
	[PageType.LABELS]: Table.Label,
	[PageType.COLORS]: Table.Color,
	[PageType.KEYS]: Table.Key,
	[PageType.ARTWORK]: Table.Artwork,
	[PageType.PLAYLIST_TREE]: Table.Playlist,
	[PageType.PLAYLIST_ENTRIES]: Table.PlaylistEntry,
};

/**
 * Maps rekordbox pdb table types to functions that create entity objects for
 * the passed pdb row.
 */
const pdbEntityCreators = {
	[PageType.TRACKS]: createTrack,
	[PageType.ARTISTS]: makeIdNameHydrator<Artist>(),
	[PageType.GENRES]: makeIdNameHydrator<Genre>(),
	[PageType.ALBUMS]: makeIdNameHydrator<Album>(),
	[PageType.LABELS]: makeIdNameHydrator<Label>(),
	[PageType.COLORS]: makeIdNameHydrator<Color>(),
	[PageType.KEYS]: makeIdNameHydrator<Key>(),
	[PageType.ARTWORK]: createArtworkEntry,
	[PageType.PLAYLIST_TREE]: createPlaylist,
	[PageType.PLAYLIST_ENTRIES]: createPlaylistEntry,

	// TODO: Register PageType.HISTORY
};
