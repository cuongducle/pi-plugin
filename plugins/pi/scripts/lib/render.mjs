function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

export function renderPiSessionCommand(sessionPath) {
  const value = String(sessionPath ?? "");
  const argument = /^[A-Za-z0-9_./:-]+$/.test(value)
    ? value
    : `"${value.replace(/[\\"$`]/g, "\\$&")}"`;
  return `pi --session ${argument}`;
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: source.line_start ?? null,
    line_end: source.line_end ?? null,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
  };
}

function appendReasoningSection(lines, reasoningSummary) {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
    return;
  }
  lines.push("", "Reasoning:");
  for (const section of reasoningSummary) {
    lines.push(`- ${section}`);
  }
}

export function renderSetupReport(report) {
  const lines = [
    "# Pi Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- pi: ${report.pi.detail}`,
    `- auth: ${report.auth.detail}`,
    `- session runtime: ${report.sessionRuntime.label}`,
    ""
  ];

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewResult(parsedResult, meta) {
  if (!parsedResult.parsed) {
    const lines = [
      `# Pi ${meta.reviewLabel}`,
      "",
      "Pi did not return valid structured JSON.",
      "",
      `- Parse error: ${parsedResult.parseError}`
    ];
    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }
    appendReasoningSection(lines, meta.reasoningSummary);
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = parsedResult.parsed;
  const findings = (Array.isArray(data.findings) ? data.findings : [])
    .map((f, i) => normalizeReviewFinding(f, i))
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  const lines = [
    `# Pi ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict ?? "unknown"}`,
    "",
    data.summary ?? "",
    ""
  ];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (Array.isArray(data.next_steps) && data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  appendReasoningSection(lines, meta.reasoningSummary);
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTaskResult(parsedResult, meta) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  if (rawOutput) {
    return rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
  }
  const message = String(parsedResult?.failureMessage ?? "").trim() || "Pi did not return a final message.";
  return `${message}\n`;
}

function pushJobDetails(lines, job, options = {}) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  lines.push(`- ${parts.join(" | ")}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.threadId) {
    lines.push(`  Pi session ID: ${job.threadId}`);
    lines.push(`  Continue in Pi: ${renderPiSessionCommand(job.threadId)}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: /pi:cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: /pi:result ${job.id}`);
  }
}

export function renderStatusReport(report) {
  const lines = ["# Pi Status", "", `Session runtime: ${report.sessionRuntime.label}`, ""];

  if (report.running.length > 0) {
    lines.push("Active jobs:");
    for (const job of report.running) {
      pushJobDetails(lines, job, { showLog: true });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, { showDuration: true });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, { showDuration: true, showLog: job.status === "failed" });
    }
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# Pi Job Status", ""];
  pushJobDetails(lines, job, {
    showLog: true,
    showCancelHint: true,
    showResultHint: true
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.rendered === "string" && storedJob.rendered) ||
    "";
  if (rawOutput) {
    const output = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    const threadId = storedJob?.threadId ?? job.threadId ?? null;
    if (!threadId) {
      return output;
    }
    return `${output}\nPi session ID: ${threadId}\nContinue in Pi: ${renderPiSessionCommand(threadId)}\n`;
  }

  const lines = [`# ${job.title ?? "Pi Result"}`, "", `Job: ${job.id}`, `Status: ${job.status}`];
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  if (threadId) {
    lines.push(`Pi session ID: ${threadId}`);
    lines.push(`Continue in Pi: ${renderPiSessionCommand(threadId)}`);
  }
  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }
  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const lines = ["# Pi Cancel", "", `Cancelled ${job.id}.`, ""];
  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  lines.push("- Check `/pi:status` for the updated queue.");
  return `${lines.join("\n").trimEnd()}\n`;
}
