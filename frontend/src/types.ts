// Shapes returned by the Django Ninja API.

export interface User {
  id: number;
  username: string;
  first_name: string;
  email: string;
}

export interface Session {
  authenticated: boolean;
  user: User | null;
  csrf_token: string;
}

export interface Track {
  id: number;
  source: "book" | "episode" | "local";
  title: string;
  position: number;
  start_ms: number;
  duration_ms: number;
  size_bytes: number;
  bitrate_kbps: number;
  channels: number;
  optimized_size_bytes: number;
  optimized_bitrate_kbps: number;
  optimized_mono: boolean;
  has_file: boolean;
  has_optimized: boolean;
  stream_url: string | null;
  transcript_status: "queued" | "running" | "ready" | "failed" | null;
  book_id: number | null;
  episode_id: number | null;
  collection_id: number | null;
}

export interface Job {
  id: number;
  kind: string;
  title: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number;
  message: string;
  error: string;
  target_type: string;
  target_id: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface AudibleAccount {
  id: number;
  name: string;
  locale: string;
  email: string;
  connected: boolean;
  login_pending: boolean;
  last_synced_at: string | null;
  last_error: string;
  book_count: number;
  ready_count: number;
}

export interface Book {
  id: number;
  account_id: number;
  account_name: string;
  asin: string;
  title: string;
  subtitle: string;
  authors: string;
  narrators: string;
  series: string;
  series_position: string;
  cover_url: string;
  runtime_min: number;
  release_date: string | null;
  purchase_date: string | null;
  percent_complete: number;
  position_ms: number;
  position_synced_at: string | null;
  is_finished: boolean;
  status: "remote" | "downloading" | "downloaded" | "converting" | "ready" | "failed";
  convert_kbps: number;
  convert_mono: boolean;
  track_count: number;
  transcribed_count: number;
}

export interface BookDetail extends Book {
  summary: string;
  tracks: Track[];
  active_job: Job | null;
}

export interface Podcast {
  id: number;
  title: string;
  author: string;
  description: string;
  image_url: string;
  feed_url: string;
  apple_url: string;
  link: string;
  last_refreshed_at: string | null;
  episode_count: number;
  downloaded_count: number;
  downloaded_bytes: number;
  total_duration_ms: number;
}

export interface Episode {
  id: number;
  title: string;
  description: string;
  published_at: string | null;
  audio_url: string;
  image_url: string;
  duration_ms: number;
  enclosure_bytes: number;
  season: number | null;
  number: number | null;
  status: "remote" | "downloading" | "ready" | "failed";
  track: Track | null;
}

export interface PodcastDetail extends Podcast {
  episodes: Episode[];
}

export interface SearchResult {
  title: string;
  author: string;
  feed_url: string;
  apple_url: string;
  image_url: string;
  episode_count: number;
  genre: string;
}

export interface Collection {
  id: number;
  name: string;
  description: string;
  source_paths: string[];
  created_at: string;
  track_count: number;
  total_bytes: number;
  total_duration_ms: number;
}

export interface CollectionDetail extends Collection {
  tracks: Track[];
}

export interface YotoAccount {
  id: number;
  name: string;
  email: string;
  connected: boolean;
  last_error: string;
  playlist_count: number;
}

export interface PlaylistItem {
  id: number;
  position: number;
  title: string;
  icon: string;
  start_ms: number | null;
  end_ms: number | null;
  track: Track;
  uploaded: boolean;
}

export interface Playlist {
  id: number;
  title: string;
  description: string;
  author: string;
  cover_url: string;
  icon: string;
  card_id: string;
  status: "draft" | "syncing" | "synced" | "changed" | "failed";
  use_optimized: boolean;
  batch: string;
  account_id: number | null;
  last_synced_at: string | null;
  last_error: string;
  updated_at: string;
  item_count: number;
  total_bytes: number;
  total_duration_ms: number;
}

export interface PlaylistDetail extends Playlist {
  items: PlaylistItem[];
  active_job: Job | null;
}

export interface PackGroup {
  key: string;
  title: string;
  track_ids: number[];
}

export interface PackCard {
  title: string;
  bytes: number;
  duration_ms: number;
  track_count: number;
  items: { track_id: number; title: string; start_ms: number | null; end_ms: number | null; bytes: number; duration_ms: number }[];
  segments: { group: string; title: string; count: number }[];
  fill: number;
  bound_by: "size" | "time";
}

export interface PackPreview {
  cards: PackCard[];
  total_bytes: number;
  total_duration_ms: number;
  limit_bytes: number;
  limit_duration_ms: number;
}

export interface Preset {
  kbps: number;
  label: string;
  note: string;
  hours_per_card_mono: number;
}

export interface TranscriptSegment {
  track_id: number;
  track_title: string;
  start_ms: number;
  end_ms: number;
  track_start_ms: number;
  text: string;
}

export interface WorkTranscript {
  tracks: { id: number; title: string; duration_ms: number; status: string | null; stream_url: string | null }[];
  segments: TranscriptSegment[];
  transcribed: number;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  position_ms: number;
  citations: number[];
  model: string;
  created_at: string;
}

export interface Conversation {
  id: number;
  title: string;
  book_id: number | null;
  episode_id: number | null;
  collection_id: number | null;
  updated_at: string;
  messages?: ChatMessage[];
}

export interface SettingsData {
  openai: { api_key: { set: boolean; masked: string }; transcription_model: string };
  anthropic: { api_key: { set: boolean; masked: string }; model: string };
  yoto: { client_id: string; client_secret: { set: boolean; masked: string } };
  preferences: {
    default_kbps: number;
    default_mono: boolean;
    card_limit_mb: number;
    card_limit_hours: number;
    pack_strategy: "sequential" | "compact";
  };
  capabilities: { local_import_roots: string[]; ffmpeg: boolean; yoto_redirect_uri: string };
}
