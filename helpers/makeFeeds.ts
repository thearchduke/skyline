import { BskyAgent } from "@atproto/api";
import { ProfileView } from "@atproto/api/dist/client/types/app/bsky/actor/defs";
import { PostView } from "@atproto/api/dist/client/types/app/bsky/feed/defs";
import {
  feedViewPostToSkylinePost,
  getFollows,
  getMutuals,
  getThreadCacheOnly,
  mergeConversationsContinual,
  unrollThread,
} from "./bsky";
import classifyLanguage, { LanguageType } from "./classifyLanguage";
import { SkylinePostType } from "./contentTypes";
const cosineSimilarity = require("compute-cosine-similarity");

// INPUT:
export type TimelineConfigType = {
  meta: {
    origin: "system" | "self" | "shared";
    createdOn?: number;
    modifiedOn?: number;
    shared?: {
      key?: string;
      createdByHandle?: string;
      createdByDid?: string;
    };
  };
  identity: {
    icon: string;
    name: string;
    description: string;
  };
  behaviour: {
    baseFeed?: "following" | "popular" | "one-from-each";
    mutualsOnly?: boolean;
    language?: LanguageType;
    replies?: "all" | "none";
    positivePrompts?: string[];
    negativePrompts?: string[];
    sorting?: "score" | "time" | "combo";
    minimumScore?: number;
  };
};
export type TimelineConfigsType = {
  [id: string]: TimelineConfigType;
};

// OUTPUT:
export type ProduceFeedOutput = {
  posts: SkylinePostType[];
  cursor: string | undefined;
};
export type TimelineDefinitionType = {
  icon: string;
  name: string;
  description: string;
  produceFeed: (params: {
    agent: BskyAgent;
    egoHandle: string;
    cursor: string | undefined;
  }) => Promise<ProduceFeedOutput>;
  postProcessFeed: (
    params: {
      agent: BskyAgent;
      egoHandle: string;
      posts: SkylinePostType[];
    },
    setPostsCallback: (posts: SkylinePostType[]) => void
  ) => void;
};

const defaultPostProcessFeed: TimelineDefinitionType["postProcessFeed"] = (
  { agent, egoHandle, posts },
  callback
) => {
  mergeConversationsContinual(agent, posts, (postsMerged) => {
    callback(postsMerged);
  });
};

function markdownQuote(text: string): string {
  return "> " + text.replace(/\n/g, "\n> ");
}

async function loadOneFromEachFeed(
  agent: BskyAgent,
  egoHandle: string,
  cursor?: string | undefined
): Promise<ProduceFeedOutput> {
  const follows = await getFollows(agent, egoHandle);

  let postsPerUser = await Promise.all(
    follows.map((follow) =>
      agent
        .getAuthorFeed({
          actor: follow.handle,
          cursor,
          limit: 15,
        })
        .then((response) => {
          if (response.success) {
            return response.data.feed
              .filter((item) => !item.reason && !item.reply)
              .map((item) => item.post);
          } else {
            return [];
          }
        })
    )
  );
  let epochs: PostView[][] = [];

  let run = true;
  while (run) {
    run = false;
    epochs.push([]);
    const epoch = epochs[epochs.length - 1];
    // Get the newest post from each user
    postsPerUser.forEach((userPosts) => {
      if (userPosts.length > 0) {
        epoch.push(userPosts.shift()!);
        run = true;
      }
    });
    // Shuffle the posts in the epoch
    epoch.sort(() => Math.random() - 0.5);
  }

  return {
    posts: epochs
      .slice(0, 1)
      .flat()
      .map((post) => ({ postView: post } as SkylinePostType)),
    cursor: undefined,
  };
}
async function loadBaseFeed(
  baseFeed: "following" | "popular",
  agent: BskyAgent,
  cursor?: string | undefined
): Promise<ProduceFeedOutput> {
  const response =
    baseFeed === "following"
      ? await agent.getTimeline({
          cursor,
          limit: 100,
        })
      : await agent.api.app.bsky.unspecced.getPopular({
          cursor,
          limit: 100,
        });

  if (response.success) {
    const posts = response.data.feed.map(feedViewPostToSkylinePost);
    return {
      posts,
      cursor: response.data.cursor,
    };
  } else {
    throw new Error("Failed to get baseFeed (" + baseFeed + ")");
  }
}
function postsToText(posts: SkylinePostType[]): string[] {
  return posts.map((post) => {
    // Compile every post we can foresee will be rendered in the feed
    let thread: SkylinePostType[] = [];
    if (post.postView.record.reply?.parent?.uri) {
      const parent = getThreadCacheOnly(post.postView.record.reply.parent.uri);
      if (parent) {
        thread = unrollThread(parent);
      }
    }
    thread.push(post);
    // Technically we'll only render the first and last two, so maybe we should filter as such
    // Otoh, it's good to have the whole thread for context, when classifying it

    // Then, take them and put them into text-only format
    const textThread = thread
      .map((item, index) => {
        const introduction =
          index === 0
            ? `${post.postView.author.displayName} (@${post.postView.author.handle}) says:\n`
            : `${post.postView.author.displayName} (@${post.postView.author.handle}) replies:\n`;

        const text = "" + (item.postView.record.text || "").trim();
        // @ts-expect-error
        const quotePost = item.postView.embed?.record?.value?.text
          ? `Quote post from ${
              // @ts-expect-error
              item.postView.embed?.record?.author?.displayName
            } (@${
              // @ts-expect-error
              item.postView.embed?.record?.author?.handle
            }):\n` +
            markdownQuote(
              // @ts-expect-error
              item.postView.embed.record.value.text.trim()
            )
          : "";
        const images = ((item?.postView?.embed?.images as []) || []).concat(
          // @ts-expect-error
          item?.postView?.embed?.media?.images || []
        );
        const image = images.length
          ? `[${images.length} ${
              images.length === 1 ? "image" : "images"
            } attached]`
          : "";

        const components = [text, quotePost, image]
          .filter((component) => component)
          .join("\n\n");

        return introduction + markdownQuote(components);
      })
      .join("\n\n---\n\n");

    return textThread;
  });
}

function average(array: number[]): number {
  return array.reduce((a, b) => a + b, 0) / array.length;
}
function max(array: number[]): number {
  return Math.max(...array);
}

const DEFAULT_PROMPT = ["says"];
export const DEFAULT_BEHAVIOUR: TimelineConfigType["behaviour"] = {
  baseFeed: "following",
  mutualsOnly: false,
  replies: "all",
  sorting: "combo",
  minimumScore: 0,
};
export function makePrincipledFeed(
  identity: TimelineConfigType["identity"],
  behaviour: TimelineConfigType["behaviour"]
): TimelineDefinitionType {
  const {
    baseFeed = "following",
    mutualsOnly = false,
    language,
    positivePrompts,
    negativePrompts,
    replies = "all",
    sorting = "combo",
    minimumScore = 0,
  } = behaviour;

  const useLLM = positivePrompts?.length || negativePrompts?.length;
  const actualPositivePrompts: string[] = positivePrompts?.length
    ? positivePrompts
    : DEFAULT_PROMPT;
  const actualNegativePrompts: string[] = negativePrompts?.length
    ? negativePrompts
    : DEFAULT_PROMPT;

  return {
    ...identity,
    produceFeed: async ({ agent, egoHandle, cursor }) => {
      // 1. DATA LOADS
      // Load mutuals list asynchronously, if required
      let mutualsPromise: Promise<ProfileView[]> = Promise.resolve([]);
      if (mutualsOnly) mutualsPromise = getMutuals(agent, egoHandle);

      // Load base feed
      let { posts, cursor: newCursor } = ["following", "popular"].includes(
        baseFeed
      )
        ? await loadBaseFeed(baseFeed as "following" | "popular", agent, cursor)
        : await loadOneFromEachFeed(agent, egoHandle, cursor);

      // 2. FILTERING
      // mutualsOnly
      if (mutualsOnly) {
        const mutuals = await mutualsPromise;
        const isMutualByDid = Object.fromEntries(
          mutuals.map((m) => [m.did, true])
        );
        posts = posts.filter((post) => isMutualByDid[post.postView.author.did]);
      }

      // replies
      if (replies === "none") {
        posts = posts.filter((item) => !item.postView.record.reply);
      } else {
        // Do nothing
      }

      // language
      if (language) {
        posts = posts.filter(
          (item) => classifyLanguage(item.postView.record.text) === language
        );
      }

      // 3. LLM SORTING
      if (useLLM) {
        // Load LLM scoring
        let positivePromptEmbeddings: number[][] = [];
        let negativePromptEmbeddings: number[][] = [];
        const embeddingsResponse = await fetch("/api/embeddings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: postsToText(posts)
              .concat(actualPositivePrompts)
              .concat(actualNegativePrompts),
          }),
        });
        const embeddings: number[][] = await embeddingsResponse.json();

        posts = posts.map((post, index) => {
          return { ...post, embedding: embeddings[index] };
        }) as SkylinePostType[];
        positivePromptEmbeddings = embeddings.slice(
          posts.length,
          posts.length + actualPositivePrompts.length
        );
        negativePromptEmbeddings = embeddings.slice(
          posts.length + actualPositivePrompts.length,
          posts.length +
            actualPositivePrompts.length +
            actualNegativePrompts.length
        );

        // score by LLM embedding
        posts = posts.map((post) => {
          const positiveScore = max(
            positivePromptEmbeddings.map((e, i) =>
              cosineSimilarity(post.embedding, e)
            )
          );
          const negativeScore = max(
            negativePromptEmbeddings.map((e, i) =>
              cosineSimilarity(post.embedding, e)
            )
          );
          const score = positiveScore - negativeScore;

          return { ...post, score };
        });
        posts = posts.filter((post) => post.score! > minimumScore);
        if (sorting === "score") {
          posts.sort((a, b) => b.score! - a.score!);
        } else if (sorting === "combo") {
          posts.sort((a, b) => {
            const bAgo =
              Date.now() - new Date(b.postView.record.createdAt).getTime();
            const aAgo =
              Date.now() - new Date(a.postView.record.createdAt).getTime();
            // 0 = sort by time, 50 ~= sort by score, 5 ~= sort by combo
            const SCORE_SENSITIVITY = 5;
            return (
              aAgo / Math.pow(a.score!, SCORE_SENSITIVITY) -
              bAgo / Math.pow(b.score!, SCORE_SENSITIVITY)
            );
          });
        }
      }

      return {
        posts,
        cursor: newCursor,
      };
    },
    postProcessFeed: defaultPostProcessFeed,
  };
}
