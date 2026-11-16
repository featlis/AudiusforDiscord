export interface Track {
  id: string;
  title: string;
  duration: number; // seconds
  permalink: string | null;
  artwork: string | null;
  genre: string | null;
  playCount: number;
  user: { handle: string; name: string };
}

export interface RoomState {
  queue: Track[];
  currentTrack: Track | null;
  isPlaying: boolean;
  position: number; // seconds, at serverNow
  serverNow: number;
  version: number;
  memberCount: number;
}

export interface DiscordUser {
  id: string;
  username: string;
}
