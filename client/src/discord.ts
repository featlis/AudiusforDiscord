import { DiscordSDK } from "@discord/embedded-app-sdk";
import type { DiscordUser } from "./types";

export interface DiscordContext {
  sdk: DiscordSDK | null;
  user: DiscordUser;
  /** Same value for everyone in the same Activity instance - used as the sync room id. */
  roomId: string;
  isMock: boolean;
}

/**
 * Inside Discord: ready() -> authorize() -> POST /api/token -> authenticate()
 * Outside Discord (plain browser dev): mock mode, room = "dev-room".
 */
export async function setupDiscord(): Promise<DiscordContext> {
  const params = new URLSearchParams(window.location.search);
  const isInDiscord = params.has("frame_id");

  if (!isInDiscord) {
    return {
      sdk: null,
      user: { id: "dev-user", username: "Dev User (mock)" },
      roomId: "dev-room",
      isMock: true,
    };
  }

  const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID as string;
  if (!clientId) throw new Error("VITE_DISCORD_CLIENT_ID is not set (client/.env)");

  const sdk = new DiscordSDK(clientId);
  await sdk.ready();

  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: ["identify"],
  });

  const tokenRes = await fetch("/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const { access_token } = await tokenRes.json();
  if (!access_token) throw new Error("Token exchange failed - check server DISCORD_CLIENT_SECRET");

  const auth = await sdk.commands.authenticate({ access_token });
  if (!auth?.user) throw new Error("Discord authenticate() returned no user");

  return {
    sdk,
    user: { id: auth.user.id, username: auth.user.username },
    roomId: sdk.instanceId,
    isMock: false,
  };
}
