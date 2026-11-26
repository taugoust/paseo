import type {
  CheckoutPrStatusResponse,
  CheckoutStatusResponse,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { isGitHubPullRequestStatusFacts } from "../../services/github-facts.js";
import type { WorkspaceGitRuntimeSnapshot } from "../workspace-git-service.js";

type CheckoutPrStatusPayload = Extract<
  SessionOutboundMessage,
  { type: "checkout_pr_status_response" }
>["payload"];
type CheckoutPrStatusPayloadStatus = NonNullable<CheckoutPrStatusPayload["status"]>;
type CheckoutPrStatusWireStatus = Omit<CheckoutPrStatusPayloadStatus, "forge"> & {
  forge?: string;
};

export function buildCheckoutStatusPayloadFromSnapshot({
  cwd,
  requestId,
  snapshot,
}: {
  cwd: string;
  requestId: string;
  snapshot: WorkspaceGitRuntimeSnapshot;
}): CheckoutStatusResponse["payload"] {
  if (!snapshot.git.isGit) {
    return {
      cwd,
      isGit: false,
      diffStat: null,
      repoRoot: null,
      currentBranch: null,
      isDirty: null,
      baseRef: null,
      aheadBehind: null,
      upstreamRef: null,
      aheadOfOrigin: null,
      behindOfOrigin: null,
      hasRemote: false,
      remoteUrl: null,
      isPaseoOwnedWorktree: false,
      error: null,
      requestId,
    };
  }

  if (snapshot.git.repoRoot === null || snapshot.git.isDirty === null) {
    throw new Error("Workspace git snapshot is missing required checkout status fields");
  }

  const { git } = snapshot;
  if (git.isPaseoOwnedWorktree) {
    if (git.mainRepoRoot === null || git.baseRef === null) {
      throw new Error("Workspace git snapshot is missing required worktree status fields");
    }

    return {
      ...gitStatusFields(snapshot, snapshot.git.repoRoot, snapshot.git.isDirty),
      cwd,
      mainRepoRoot: git.mainRepoRoot,
      baseRef: git.baseRef,
      isPaseoOwnedWorktree: true,
      requestId,
    };
  }

  return {
    ...gitStatusFields(snapshot, snapshot.git.repoRoot, snapshot.git.isDirty),
    cwd,
    mainRepoRoot: git.mainRepoRoot,
    baseRef: git.baseRef ?? null,
    isPaseoOwnedWorktree: false,
    requestId,
  };
}

/** The checkout status fields shared by plain checkouts and Paseo worktrees. */
function gitStatusFields(
  snapshot: WorkspaceGitRuntimeSnapshot,
  repoRoot: string,
  isDirty: boolean,
) {
  const { git } = snapshot;
  return {
    isGit: true as const,
    diffStat: git.diffStat ?? null,
    repoRoot,
    currentBranch: git.currentBranch ?? null,
    isDirty,
    baseRefExact: git.baseRefExact,
    comparisonBaseRef: git.comparisonBaseRef,
    aheadBehind: git.aheadBehind ?? null,
    upstreamRef: git.upstreamRef ?? null,
    aheadOfOrigin: git.aheadOfOrigin ?? null,
    behindOfOrigin: git.behindOfOrigin ?? null,
    upstreamState: git.upstreamState,
    hasRemote: git.hasRemote,
    pullRemote: git.pullRemote,
    pushRemote: git.pushRemote,
    firstPushRemote: git.firstPushRemote,
    remoteUrl: git.remoteUrl,
    ...(snapshot.forgeWeb ? { forgeWeb: snapshot.forgeWeb } : {}),
    error: null,
  };
}

export function buildCheckoutPrStatusPayloadFromSnapshot({
  cwd,
  requestId,
  snapshot,
}: {
  cwd: string;
  requestId: string;
  snapshot: WorkspaceGitRuntimeSnapshot;
}): CheckoutPrStatusResponse["payload"] {
  // Prefer the forge resolved during snapshot refresh (probe-aware, so
  // self-managed GitLab hosts are correct). forgeSpecific.forge is only a facts
  // family tag, not a brand id, so unresolved snapshots stay unlabeled.
  const forge = snapshot.forge.forge;
  return {
    cwd,
    status: normalizeCheckoutPrStatusPayload(snapshot.forge.pullRequest, forge),
    githubFeaturesEnabled: snapshot.forge.featuresEnabled,
    authState: snapshot.forge.authState,
    ...(forge ? { forge } : {}),
    error: snapshot.forge.error
      ? {
          code: "UNKNOWN",
          message: snapshot.forge.error.message,
        }
      : null,
    requestId,
  } as CheckoutPrStatusResponse["payload"];
}

export function normalizeCheckoutPrStatusPayload(
  status: WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"],
  forge?: string,
): CheckoutPrStatusPayloadStatus | null {
  if (!status) {
    return null;
  }
  const payload: CheckoutPrStatusWireStatus = {
    ...(forge ? { forge } : {}),
    number: status.number,
    url: status.url,
    title: status.title,
    state: status.state,
    repoOwner: status.repoOwner,
    repoName: status.repoName,
    baseRefName: status.baseRefName,
    headRefName: status.headRefName,
    isMerged: status.isMerged,
    isDraft: status.isDraft ?? false,
    mergeable: status.mergeable ?? "UNKNOWN",
    checks: status.checks ?? [],
    checksStatus: status.checksStatus,
    reviewDecision: status.reviewDecision,
  };
  if (status.projectPath) {
    payload.projectPath = status.projectPath;
  } else if (status.repoOwner && status.repoName) {
    payload.projectPath = `${status.repoOwner}/${status.repoName}`;
  }
  if (status.forgeSpecific) {
    payload.forgeSpecific = status.forgeSpecific;
    // COMPAT(forgeSpecific): forgeSpecific shipped in v0.2.0-beta.1. Keep
    // mirroring GitHub facts onto `github` for clients that predate it. Stop
    // emitting the mirror after 2027-01-17 once the supported client floor
    // is >= v0.2.0.
    if (isGitHubPullRequestStatusFacts(status.forgeSpecific)) {
      const { forge: _forge, ...githubFacts } = status.forgeSpecific;
      payload.github = githubFacts;
    }
  }
  return payload as CheckoutPrStatusPayloadStatus;
}
