import { deserialize } from "bson";
import { writeFile, readFile } from "fs";
import { promisify } from "util";
import { NetlifyIntegration } from "@netlify/sdk";

const readFileAsync = promisify(readFile);
const writeFileAsync = promisify(writeFile);

const integration = new NetlifyIntegration();
const BUNDLE_PATH = `${process.cwd()}/bundle`;
const REDOC_CLI_VERSION = "1.2.3";

export interface OASPageMetadata {
  source_type: string;
  source: string;
  api_version?: string;
  resource_versions?: string[];
}

export type OASPagesMetadata = Record<string, OASPageMetadata>;

// handle installing redoc cli if it's not already installed
integration.addBuildEventHandler(
  "onPreBuild",
  async ({ utils: { run, cache } }) => {
    console.log("Running redoc prebuild");
    const hasRedoc = await cache.has("redoc");
    if (hasRedoc) {
      console.log("Restoring redoc from cache");

      cache.restore("redoc");
      return;
    }

    await run.command(
      `git clone -b @dop/redoc-cli@${REDOC_CLI_VERSION} --depth 1 https://github.com/mongodb-forks/redoc.git redoc`
    );

    await run.command("npm ci --prefix cli/ --omit=dev", {
      cwd: `${process.cwd()}/redoc`,
    });

    await cache.save("redoc");
  }
);

interface GetOASpecParams {
  sourceType: string;
  source: string;
  output: string;
  pageSlug: string;
  siteUrl: string;
  siteTitle: string;
}

export const normalizePath = (path: string) => path.replace(/\/+/g, `/`);
export const normalizeUrl = (url: string) => {
  const urlObject = new URL(url);
  urlObject.pathname = normalizePath(urlObject.pathname);
  return urlObject.href;
};
export interface RedocVersionOptions {
  active: {
    apiVersion: string;
    resourceVersion: string;
  };
  rootUrl: string;
  resourceVersions: string[];
}

async function getOASpecCommand({
  source,
  sourceType,
  pageSlug,
  output,
  siteUrl,
  siteTitle,
}: GetOASpecParams) {
  try {
    let spec = "";
    if (sourceType === "local") {
      const localFilePath = `source${source}`;
      spec = localFilePath;
    } else {
      throw new Error(
        `Unsupported source type "${sourceType}" for ${pageSlug}`
      );
    }

    const path = `${output}/${pageSlug}/index.html`;
    const finalFilename = normalizePath(path);
    await writeFileAsync(
      `${process.cwd()}/options.json`,
      JSON.stringify({ siteUrl, siteTitle })
    );
    return `node ${process.cwd()}/redoc/cli/index.js build ${spec} --output ${finalFilename} --options ${process.cwd()}/options.json`;
  } catch (e) {
    console.error(e);
    return "";
  }
}

// handle building the redoc pages
integration.addBuildEventHandler("onPostBuild", async ({ utils: { run } }) => {
  console.log("=========== Redoc Integration Begin ================");
  await run.command("unzip bundle.zip -d bundle");

  const siteBson = await readFileAsync(`${BUNDLE_PATH}/site.bson`);

  const buildMetadata = deserialize(siteBson);
  const siteTitle: string = buildMetadata["title"];
  const openapiPages: OASPagesMetadata | undefined =
    buildMetadata["openapi_pages"];

  if (!openapiPages) {
    console.log("No OpenAPI pages found");
    return;
  }

  const openapiPagesEntries = Object.entries(openapiPages);
  const siteUrl = process.env.DEPLOY_PRIME_URL || "";

  for (const [pageSlug, data] of openapiPagesEntries) {
    const { source_type: sourceType, source } = data;

    const command = await getOASpecCommand({
      source,
      sourceType,
      output: `${process.cwd()}/snooty/public`,
      pageSlug,
      siteUrl,
      siteTitle,
    });

    await run.command(command);
  }

  console.log("=========== Redoc Integration End ================");
});

// cache redoc
integration.addBuildEventHandler("onSuccess", async ({ utils: { cache } }) => {
  const hasRedoc = await cache.has("redoc");
  if (!hasRedoc) {
    console.log("saving redoc to cache");
    await cache.save("redoc");
  }
});

export { integration };
