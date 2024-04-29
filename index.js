// Import required libraries
const fs = require("fs");
const csv = require("csv-parser");
const core = require("@actions/core");
const { Octokit } = require("@octokit/rest");
const { createAppAuth } = require("@octokit/auth-app");
const { paginateRest } = require("@octokit/plugin-paginate-rest");
const zlib = require("zlib");

const { throttling } = require("@octokit/plugin-throttling");

const { fail } = require("assert");
const { default: test } = require("node:test");

// Source and target
const sourceOrg = core.getInput("source_org");
const sourceRepo = core.getInput("source_repo");
const targetOrg = core.getInput("target_org");
const targetRepo = core.getInput("target_repo");

// Settings for Octokit
// source
const sourceAPIUrl = core.getInput("source_github_api_url") || "https://api.github.com";
const sourcePAT = core.getInput("source_github_pat");

const sourceAppId = core.getInput("source_github_app_id");
const sourceAppPrivateKey = core.getInput("source_github_app_private_key");
const sourceAppInstallationId = core.getInput("source_github_app_installation_id");

// target
const targetAPIUrl = core.getInput("target_github_api_url") || sourceAPIUrl;
const targetPAT = core.getInput("target_github_pat");

const targetAppId = core.getInput("target_github_app_id") || sourceAppId;
const targetAppPrivateKey = core.getInput("target_github_app_private_key") || sourceAppPrivateKey;
const targetAppInstallationId = core.getInput("target_github_app_installation_id") || sourceAppInstallationId;

const MyOctokit = Octokit.plugin(throttling).plugin(paginateRest);

let failedMigrations = [];

core.info(`isDebug? ${core.isDebug()}`);

// Create Octokit instances for source and target
const sourceOctokit = createOctokitInstance(
  sourcePAT,
  sourceAppId,
  sourceAppPrivateKey,
  sourceAppInstallationId,
  sourceAPIUrl
);
const targetOctokit = createOctokitInstance(
  targetPAT,
  targetAppId,
  targetAppPrivateKey,
  targetAppInstallationId,
  targetAPIUrl
);

// Function to create Octokit instance
function createOctokitInstance(PAT, appId, appPrivateKey, appInstallationId, apiUrl) {
  // Prefer app auth to PAT if both are available
  const throttle = {
    onRateLimit: (retryAfter, options, octokit, retryCount) => {
      octokit.log.warn(`Request quota exhausted for request ${options.method} ${options.url}`);

      if (retryCount < 1) {
        // only retries once
        octokit.log.info(`Retrying after ${retryAfter} seconds!`);
        return true;
      }
    },
    onSecondaryRateLimit: (retryAfter, options, octokit) => {
      // does not retry, only logs a warning
      octokit.log.warn(`SecondaryRateLimit detected for request ${options.method} ${options.url}`);
    },
  };
  if (appId && appPrivateKey && appInstallationId) {
    return new MyOctokit({
      throttle: throttle,
      authStrategy: createAppAuth,
      auth: {
        appId: appId,
        privateKey: appPrivateKey,
        installationId: appInstallationId,
      },
      baseUrl: apiUrl,
      log: core.isDebug() ? console : null,
    });
  } else {
    return new MyOctokit({
      throttle: throttle,
      auth: PAT,
      baseUrl: apiUrl,
      log: core.isDebug() ? console : null,
    });
  }
}

async function listRepoSarifFiles(octokit, owner, repo) {
  // List all SARIF results ids for a GitHub repo
  var data = [];
  try {
    data = (
      await octokit.request("GET /repos/{owner}/{repo}/code-scanning/analyses", {
        owner: owner,
        repo: repo,
        headers: {
          "X-GitHub-Api-Version": "2022-11-28",
        },
      })
    ).data;
  } catch (error) {
    octokit.log.warn("Could not get SARIF data for repo, skipping");
    octokit.log.debug(error);
  }
  return data;
}

async function getSarifFile(octokit, owner, repo, analysis_id) {
  // Get SARIF results for a specific id
  var data = [];
  try {
    data = (
      await octokit.request("GET /repos/{owner}/{repo}/code-scanning/analyses/{analysis_id}", {
        owner: owner,
        repo: repo,
        analysis_id: analysis_id,
        headers: {
          "X-GitHub-Api-Version": "2022-11-28",
          Accept: "application/sarif+json",
        },
      })
    ).data;
  } catch (error) {
    octokit.log.warn(`Could not get SARIF data for analysis id "${analysis_id}", skipping`);
    octokit.log.debug(error);
  }
  return data;
}

// Do the equivalent of `gzip -c analysis-data.sarif | base64 -w0`
async function compressFile(input) {
  const output = new Promise(function (resolve, reject) {
    zlib.gzip(input, (err, buffer) => {
      if (!err) {
        resolve(buffer.toString("base64"));
      } else {
        console.log(err);
        reject(err);
      }
    });
  });
  return output;
}

async function uploadSarifFile(octokit, owner, repo, commit_sha, ref, sarif) {
  //upload the SARIF file to the destination repository
  return await octokit.request("POST /repos/{owner}/{repo}/code-scanning/sarifs", {
    owner: owner,
    repo: repo,
    commit_sha: commit_sha,
    ref: ref,
    sarif: sarif,
    headers: {
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
}

async function main(sourceOctokit, sourceOrg, sourceRepo, targetOctokit, targetOrg, targetRepo) {
  core.info(`Processing SARIF files from repo "${sourceOrg}/${sourceRepo}"`);
  var data = await listRepoSarifFiles(sourceOctokit, sourceOrg, sourceRepo);

  core.debug(`Got scans:\n${JSON.stringify(data)}`);
  for (const item of data) {
    core.info(`Processing SARIF results for scan with ID: "${item.id}"`);
    core.debug(`Scan:\n${JSON.stringify(item)}`);
    const analysis_data = await getSarifFile(sourceOctokit, sourceOrg, sourceRepo, item.id);

    core.debug(`Scan returned analysis data:\n${JSON.stringify(analysis_data)}`);
    const sarif = await compressFile(JSON.stringify(analysis_data));

    core.info(`Uploading scan results to "${targetOrg}/${targetRepo} for ref "${item.ref}", sha "${item.commit_sha}"`);
    try {
      const upload = await uploadSarifFile(targetOctokit, targetOrg, targetRepo, item.commit_sha, item.ref, sarif);
      core.debug(`Upload returned ${JSON.stringify(upload)}`);
    } catch (error) {
      const errorMessage = `Commit: ${item.commit_sha}, ref: ${item.ref}, sourceId: ${item.id}`;
      failedMigrations.push(errorMessage);
      core.info("Error uploading results. Continuing.");
      core.error(errorMessage);
      core.error(error);
    }
  }

  if (failedMigrations.length) {
    core.error("Failed to migrate the following items to the destination");
    for (const migration of failedMigrations) {
      core.error(`\t${migration}`);
    }
  }
}

main(sourceOctokit, sourceOrg, sourceRepo, targetOctokit, targetOrg, targetRepo);
