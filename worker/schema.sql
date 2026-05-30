CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_code TEXT NOT NULL UNIQUE,
  creator_name TEXT NOT NULL,
  seed_prefs TEXT,                 -- JSON: { genres: string[], decades: string[], languages: string[], energy: number }
  dj_taste_seed TEXT,              -- JSON: DjTasteTrack[] — the DJ's own Spotify top/liked tracks (fetched by the DO at ride start)
  spotify_refresh_token TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  name TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  UNIQUE(trip_id, name)
);

CREATE TABLE IF NOT EXISTS songs (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  spotify_track_id TEXT NOT NULL,
  spotify_uri TEXT,                -- spotify:track:... played on the DJ device
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  album_art TEXT,
  reason TEXT,                     -- Claude's one-line rationale for the pick
  play_order INTEGER NOT NULL DEFAULT 0,
  identified_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ratings (
  id TEXT PRIMARY KEY,
  song_id TEXT NOT NULL REFERENCES songs(id),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  emoji TEXT NOT NULL CHECK(emoji IN ('🔥','❤️','😐','😬','💀')),
  score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
  submitted_at INTEGER NOT NULL,
  UNIQUE(song_id, participant_id)
);

-- Cached Claude analysis so we don't re-bill on every tab open.
-- Regenerated when rated_songs_count changes.
CREATE TABLE IF NOT EXISTS analysis_cache (
  trip_id TEXT PRIMARY KEY REFERENCES trips(id),
  payload TEXT NOT NULL,
  rated_songs_count INTEGER NOT NULL,
  generated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_participants_trip ON participants(trip_id);
CREATE INDEX IF NOT EXISTS idx_songs_trip ON songs(trip_id);
CREATE INDEX IF NOT EXISTS idx_ratings_song ON ratings(song_id);
CREATE INDEX IF NOT EXISTS idx_ratings_participant ON ratings(participant_id);
