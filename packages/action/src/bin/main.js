//#!/usr/bin/env node
const { logger } = require("../lib/logger");
const {
  getOrderedListForTree
} = require("@kie/build-chain-configuration-reader");
const { createOctokitInstance } = require("../utils/bin-utils");
const {
  getPullRequests,
  getChecks,
  getRepository,
  getRefStatuses
} = require("../lib/git-service");
const { ClientError } = require("../lib/common");
const { filterPullRequests } = require("../utils/pullrequest-utils");
const { formatDate } = require("../utils/date-util");
const fs = require("fs");
const path = require("path");

const getMetadata = args => ({
  title: args.title,
  subtitle: args.subtitle,
  date: new Date(),
  createdBy: args.createdBy,
  createdUrl: args.createdUrl
});

const mapUser = user => ({
  login: user.login,
  avatar_url: user.avatar_url,
  html_url: user.html_url
});

const mapCheck = check => ({
  id: check.id,
  name: check.name ? check.name : check.context,
  html_url: check.html_url,
  status: check.status,
  conclusion: check.conclusion,
  started_at: check.started_at,
  completed_at: check.completed_at,
  slug: check.app.slug,
  avatar_url: check.app.owner.avatar_url
});

const mapStatus = status => ({
  id: status.id,
  name: status.name
    ? status.name
    : status.context
    ? status.context
    : status.description,
  html_url: status.target_url,
  conclusion: status.state,
  started_at: status.created_at,
  completed_at: status.updated_at,
  slug: status.target_url ? status.target_url.includes("jenkins") : "unknown",
  avatar_url: status.avatar_url
});

const loadChecks = async (node, sha, octokit) => {
  const checks = (await getChecks(node.project, sha, octokit)).map(mapCheck);
  const statuses = (await getRefStatuses(node.project, sha, octokit)).map(
    mapStatus
  );
  // if (
  //   node.project === "kiegroup/droolsjbpm-build-bootstrap" &&
  //   statuses &&
  //   statuses.length
  // ) {
  //   // logger.debug("checks", ref, checks);
  //   logger.debug("statuses", ref, statuses);
  //   process.exit(1);
  // }
  return [...checks, ...statuses];
};

const mapPullRequest = async (node, pullRequest, octokit) => {
  return await {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    html_url: pullRequest.html_url,
    state: pullRequest.state,
    labels: pullRequest.labels.reduce((acc, curr) => [...acc, curr.name], []),
    draft: pullRequest.draft,
    requested_reviewers: pullRequest.requested_reviewers.map(mapUser),
    created_at: pullRequest.created_at,
    updated_at: pullRequest.updated_at,
    closed_at: pullRequest.closed_at,
    merged_at: pullRequest.merged_at,
    base: {
      ref: pullRequest.base.ref,
      sha: pullRequest.base.sha,
      label: pullRequest.base.label
    },
    head: {
      ref: pullRequest.head.ref,
      sha: pullRequest.head.sha,
      label: pullRequest.head.label
    },
    user: mapUser(pullRequest.user),
    checks: await loadChecks(node, pullRequest.head.sha, octokit)
  };
};

const mapPullRequestInfo = async (node, pullRequests, octokit) => {
  const baseRepo =
    pullRequests && pullRequests.length
      ? pullRequests[0].base.repo
      : await getRepository(node.project, octokit);
  return {
    key: node.project,
    name: baseRepo.name,
    description: baseRepo.description,
    html_url: baseRepo.html_url,
    updated_at: baseRepo.updated_at,
    homepage: baseRepo.homepage,
    language: baseRepo.language,
    default_branch: baseRepo.default_branch,
    repo_url: baseRepo.html_url,
    pulls_url: baseRepo.pulls_url,
    pullRequests: await Promise.all(
      pullRequests.map(async e => await mapPullRequest(node, e, octokit))
    )
  };
};

const saveFiles = (data, outputFolderPath, extesion = "json") => {
  logger.info(`Writting files to ${outputFolderPath}`);
  if (!fs.lstatSync(outputFolderPath).isDirectory()) {
    throw new ClientError(`${outputFolderPath} is not a directory.`);
  }

  const todayFilePath = path.join(
    outputFolderPath,
    `${formatDate(new Date())}.${extesion}`
  );
  logger.info(`Writting file to ${todayFilePath}`);
  fs.writeFileSync(todayFilePath, data);

  const latestFilePath = path.join(outputFolderPath, `latest.${extesion}`);
  logger.info(`Writting file to ${latestFilePath}`);
  fs.writeFileSync(latestFilePath, data);
};

async function main(args) {
  logger.level = args.debug ? "debug" : "info";
  logger.debug("args", args);
  const octokit = createOctokitInstance(args.token);

  logger.info(`Getting projects from definition file ${args.definitionFile}`);
  const orderedList = await getOrderedListForTree(args.definitionFile, {
    token: args.token
  });
  if (!orderedList || !orderedList.length) {
    throw new ClientError("No projects on the definition file");
  }

  const pullRequestInformation = await Promise.all(
    orderedList.map(async node => {
      try {
        return await mapPullRequestInfo(
          node,
          filterPullRequests(
            orderedList[0],
            node,
            await getPullRequests(node.project, octokit, {
              state: "open",
              page: 1,
              per_page: 100
            }),
            args.baseBranchFilter
          ),
          octokit
        );
      } catch (err) {
        throw { project: node.project, message: err };
      }
    })
  )
    .then(result => result.reduce((acc, curr) => [...acc, curr], []))
    .catch(err => {
      logger.error(`[${err.project}] Error checking it out. ${err.message}`);
      throw err.message;
    });
  saveFiles(
    JSON.stringify(
      { metadata: getMetadata(args), projects: pullRequestInformation },
      null,
      args.debug ? 2 : 0
    ),
    args.outputFolderPath
  );
}

if (require.main === module) {
  main();
}
module.exports = { main };
