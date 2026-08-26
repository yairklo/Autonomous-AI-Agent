/**
 * Fan-out a newly discovered live job into the JSON JobDb + Telegram approval path.
 */

export async function notifyLiveJob(matched, { groupName = '', onLog = () => {} } = {}) {
  try {
    const { scanAndEnqueueJobs, loadJobsConfig } = await import('../jobs/pipeline.js');
    const jobsConfig = loadJobsConfig();
    await scanAndEnqueueJobs({
      messages: [
        {
          ...matched,
          groupName: groupName || matched.groupName,
          body: matched.text || matched.body,
          text: matched.text || matched.body,
          hasMedia: false,
        },
      ],
      notifyTelegram: true,
      dryRunTelegram: !jobsConfig.telegram?.botToken,
      onLog,
    });
  } catch (err) {
    onLog(`[whatsapp-ingest] telegram/json enqueue failed: ${err.message}`);
  }
}
