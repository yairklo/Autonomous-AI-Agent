/**
 * Fan-out a newly discovered live job into the JSON JobDb + Telegram approval path.
 */

export async function notifyLiveJob(matched, { groupName = '', jobsConfig, onLog = () => {} } = {}) {
  try {
    const { scanAndEnqueueJobs, loadJobsConfig } = await import('../jobs/pipeline.js');
    // Prefer the config the caller already loaded (ingest.js) so this
    // second matching/enqueue pass can't disagree with the first if
    // config.json changes between the two loads.
    const resolvedJobsConfig = jobsConfig || loadJobsConfig();
    await scanAndEnqueueJobs({
      jobsConfig: resolvedJobsConfig,
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
      dryRunTelegram: !resolvedJobsConfig.telegram?.botToken,
      onLog,
    });
  } catch (err) {
    onLog(`[whatsapp-ingest] telegram/json enqueue failed: ${err.message}`);
  }
}
