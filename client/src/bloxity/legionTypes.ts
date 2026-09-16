/**
 * The Bloxity SDK's shape, as this game uses it.
 *
 * The SDK ships as a plain script that installs `window.Legion`, with no types
 * of its own. These declarations are the CONTRACT this game codes against -
 * deliberately narrow: only what is actually called, so a change on their side
 * shows up as a type error here rather than as a runtime surprise in a
 * deployed build.
 *
 * Every member is optional at the call site through `sdk()` in `Bloxity.ts`,
 * because the script is loaded from a third-party CDN and may simply not be
 * there - offline, blocked, or an older build that predates a namespace.
 */

export interface LegionUser {
  readonly _id: string;
  readonly username: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly pfp?: string;
  readonly avatar?: string;
}

/**
 * A friend's presence.
 *
 * The status strings are spelled both ways in the wild - the docs say
 * `in-game`, the reference implementation emits `in_game` - so anything
 * reading this must accept both. `presenceLabel` in `BloxityPanel` is the one
 * place that decides.
 */
export interface LegionPresence {
  readonly status: 'online' | 'in-game' | 'in_game' | 'away' | 'offline';
  readonly currentGame?: string;
  readonly currentRoom?: string;
  readonly currentParty?: string;
  readonly gameSlug?: string;
  readonly gameName?: string;
  readonly lastSeen?: string;
}

export interface LegionFriend {
  readonly _id: string;
  readonly username: string;
  readonly displayName?: string;
  readonly pfp?: string;
  readonly presence?: LegionPresence;
}

/** Equipped cosmetic ids. `'-1'`, `''`, `'undefined'` and null all mean NONE. */
export interface LegionEquipped {
  readonly hatId?: string | null;
  readonly backId?: string | null;
  readonly skinId?: string | null;
  readonly headId?: string | null;
  readonly armLId?: string | null;
  readonly armRId?: string | null;
  readonly legLId?: string | null;
  readonly legRId?: string | null;
  readonly torsoId?: string | null;
}

/** Avatar proportions. Every value is a multiplier defaulting to 1. */
export interface LegionProportions {
  readonly height: number;
  readonly shoulderWidth: number;
  readonly armLength: number;
  readonly legOffsetX: number;
  readonly torsoScaleX: number;
  readonly neckHeight: number;
  readonly headScale: number;
}

export interface LegionPurchaseResult {
  readonly success: boolean;
  readonly transactionId?: string;
  readonly error?: string;
}

export interface LegionFriendRequestResult {
  readonly success: boolean;
  readonly status?: 'accepted' | 'pending';
  readonly error?: string;
}

/** What a player event carries. `respawn_request` carries nothing. */
export type LegionPlayerEvent =
  | 'respawn_request'
  | 'chat_message_sent'
  | 'pointer_lock_changed';

export interface LegionSdk {
  init(options: { gameSlug: string }): void;

  auth?: {
    getUser(): LegionUser | null;
    getToken(): string | null;
    isLoggedIn(): boolean;
    showAuthPopup(): Promise<LegionUser | null>;
    logout(): void;
    onUserChanged(callback: (user: LegionUser | null) => void): () => void;
    authenticateWithServer(url: string): Promise<unknown | null>;
  };

  avatar?: {
    getEquipped(): LegionEquipped;
    getProportions(): LegionProportions;
    setProportions(partial: Partial<LegionProportions>): Promise<unknown>;
    resetProportions(): Promise<unknown>;
    onAvatarChanged(callback: (equipped: LegionEquipped) => void): () => void;
    onProportionsChanged(
      callback: (proportions: LegionProportions) => void,
    ): () => void;
    showCustomizer(): void;
    hideCustomizer(): void;
    toggleCustomizer(): void;
    isCustomizerOpen(): boolean;
  };

  social?: {
    getFriends(): Promise<LegionFriend[]>;
    inviteFriend(userId: string): Promise<boolean>;
    getInviteFriendsLink(options?: {
      gameSlug?: string;
      roomId?: string;
      partyId?: string;
      baseUrl?: string;
      ref?: string;
    }): string;
    sendFriendRequest(userId: string): Promise<LegionFriendRequestResult>;
  };

  settings?: {
    listen(key: string, callback: (value: string) => void): () => void;
    get(key: string): string;
    getAll(): Record<string, string>;
    onChanged(callback: (settings: Record<string, string>) => void): () => void;
    triggerAll(): void;
    refresh(): void;
  };

  game?: {
    loadingStep(text: string): void;
    loadingEnd(): void;
    gameplayStart(): void;
    gameplayEnd(): void;
    updateRoom(roomId: string, partyId?: string): void;
    playerJoined(username: string): void;
    playerInRoom(username: string): void;
  };

  player?: {
    onEvent(
      callback: (event: LegionPlayerEvent, data?: unknown) => void,
    ): () => void;
  };

  bux?: {
    requestPurchase(
      sku: string,
      metadata?: Record<string, unknown>,
    ): Promise<LegionPurchaseResult>;
    getBalance(): Promise<number>;
  };

  portal?: {
    isInIframe(): boolean;
    isEmbeddedInLegion(): boolean;
    requestFullscreen(): void;
    exitFullscreen(): void;
    showMenu(lockCursorOnResume?: boolean): void;
  };

  api?: {
    get(path: string): Promise<unknown>;
    post(path: string, body?: unknown): Promise<unknown>;
    patch(path: string, body?: unknown): Promise<unknown>;
    delete(path: string): Promise<unknown>;
  };
}

declare global {
  interface Window {
    Legion?: { SDK?: LegionSdk };
  }
}

/** An id is only equipped if it is a real one. */
export const isEquippedId = (id: string | null | undefined): id is string =>
  id != null && id !== '' && id !== '-1' && id !== 'undefined';
