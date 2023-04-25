import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";

interface Options {
  skipsChecked: boolean;
  allStepsPass: boolean;
  includeLabel: string | null;
  ignoreLabel: string | null;
}

async function combineSnykPRs(token: string, owner: string, repo: string, options: Options) {
  const octokit = new Octokit({ auth: token });

  const { data: pullRequests } = await octokit.rest.pulls.list({
    owner,
    repo,
    state: "open",
  });

  const snykUpgradePRs = pullRequests.filter((pr) => pr.head.ref.startsWith("snyk-upgrade-"));

  const filteredPRs = await Promise.all(
    snykUpgradePRs.filter(async (pr) => {
      if (options.ignoreLabel) {
        const hasIgnoreLabel = pr.labels.some((label) => label.name === options.ignoreLabel);
        if (hasIgnoreLabel) return false;
      }

      if (options.includeLabel) {
        const hasIncludeLabel = pr.labels.some((label) => label.name === options.includeLabel);
        if (!hasIncludeLabel) return false;
      }

      if (options.allStepsPass || options.skipsChecked) {
        const { data: combinedStatus } = await octokit.rest.repos.getCombinedStatusForRef({
          owner,
          repo,
          ref: pr.head.sha,
        });

        if (options.allStepsPass && combinedStatus.state !== "success") return false;

        if (options.skipsChecked && combinedStatus.state !== "success" && combinedStatus.state !== "skipped") {
          return false;
        }
      }

      return true;
    })
  );

  const newBranchName = "combined-snyk-security-updates";
  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${newBranchName}`,
    sha: (await octokit.rest.git.getRef({ owner, repo, ref: "heads/main" })).data.object.sha,
  });

  for (const pr of filteredPRs) {
    await octokit.rest.repos.merge({
      owner,
      repo,
      base: newBranchName,
      head: pr.head.ref,
      commit_message: `Merge branch '${pr.head.ref}'`,
    });
  }

  await octokit.rest.pulls.create({
    owner,
    repo,
    title: "chore: combined Snyk security updates",
    head: newBranchName,
    base: "main",
    body: "This PR combines the changes from the following Snyk upgrade PRs:\n" + filteredPRs.map((pr) => `- ${pr.title}`).join("\n"),
  });
}

(async () => {
  try {
    const token = core.getInput("token", { required: true });
    const [owner, repo] = process.env.GITHUB_REPOSITORY?.split("/") ?? ["", ""];
    const skipsChecked = core.getInput("skipsChecked") === "true";
    const allStepsPass = core.getInput("allStepsPass") === "true";
    const includeLabel = core.getInput("includeLabel");
    const ignoreLabel = core.getInput("ignoreLabel");

    const options = { skipsChecked, allStepsPass, includeLabel, ignoreLabel };
    await combineSnykPRs(token, owner, repo, options);
} catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An error occurred, panic 😨");
    }
  }
})();
