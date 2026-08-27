import path from 'node:path';
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import { config as appConfig } from '../config.js';
import { driveTrackerStatus, syncTrackerToDrive } from '../jobs-engine/drive-tracker.js';

const TRACKER_FILE = path.join(appConfig.root, 'data', 'job_applications.xlsx');

const COLUMNS = [
  { header: 'ID', key: 'id', width: 10 },
  { header: 'Submission Date', key: 'date', width: 25 },
  { header: 'Status', key: 'status', width: 20 },
  { header: 'Job Title & Target Role', key: 'role', width: 30 },
  { header: 'Company Name', key: 'company', width: 25 },
  { header: 'Source / Group', key: 'source', width: 30 },
  { header: 'Original Description', key: 'description', width: 60 },
  { header: 'Job URL', key: 'url', width: 40 },
  { header: 'Cover Letter', key: 'coverLetter', width: 60 },
  { header: 'Match Score / Keywords', key: 'score', width: 25 },
  { header: 'Error Log', key: 'error', width: 40 },
];

/**
 * Initializes or loads the workbook and worksheet.
 */
async function getWorkbook() {
  const workbook = new ExcelJS.Workbook();
  let worksheet;
  let isNewSheet = false;

  if (fs.existsSync(TRACKER_FILE)) {
    await workbook.xlsx.readFile(TRACKER_FILE);
    worksheet = workbook.getWorksheet('Applications');
  } else {
    // Ensure directory exists
    fs.mkdirSync(path.dirname(TRACKER_FILE), { recursive: true });
    workbook.creator = 'Voice Agent';
    workbook.created = new Date();
  }

  if (!worksheet) {
    worksheet = workbook.addWorksheet('Applications', {
      views: [{ rightToLeft: true }] // RTL for Hebrew
    });
    isNewSheet = true;
  }

  // ExcelJS's key->column mapping (used by row.getCell(key) below) lives only
  // in memory — it isn't part of the .xlsx format, so a worksheet reloaded
  // from disk loses it and every lookup after the very first write would
  // throw "Invalid column letter: id". Re-applying the same column defs is
  // idempotent (same headers/order) and restores the mapping on every load.
  worksheet.columns = COLUMNS;

  if (isNewSheet) {
    // Style the header row
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
  }

  return { workbook, worksheet };
}

/**
 * Map internal DB statuses to tracker display labels.
 */
function displayTrackerStatus(status) {
  const s = String(status || 'detected');
  if (s === 'submitted' || s === 'Submitted') return 'Submitted';
  if (
    s === 'requires_manual_action' ||
    s === 'Requires Manual Action'
  ) {
    return 'Requires Manual Action';
  }
  if (
    s === 'submit_failed' ||
    s === 'Submission Failed' ||
    s === 'submission_failed'
  ) {
    return 'Submission Failed';
  }
  return s;
}

// pipeline.js fires updateJobInTracker without awaiting it. Two concurrent
// calls would each read the same on-disk .xlsx, mutate their own in-memory
// copy, and write it back — the loser's write can corrupt the zip container
// entirely ("Corrupted zip or bug"), not just lose an update. Serialize all
// writes through one chain so each read-modify-write cycle completes before
// the next one starts.
let writeChain = Promise.resolve();

/**
 * Update or insert a job into the Excel tracker.
 * @param {object} job The job object from the local DB.
 */
export function updateJobInTracker(job) {
  const run = writeChain.then(() => updateJobInTrackerNow(job));
  writeChain = run.catch(() => {});
  return run;
}

async function updateJobInTrackerNow(job) {
  try {
    const { workbook, worksheet } = await getWorkbook();

    // Find if the job already exists by ID
    let rowIndex = -1;
    worksheet.eachRow((row, rowNumber) => {
      if (row.getCell('id').value === job.id) {
        rowIndex = rowNumber;
      }
    });

    const dateStr = job.submittedAt || job.createdAt || new Date().toISOString();
    const status = displayTrackerStatus(job.status);
    const roles = (job.rolesMatched || []).join(', ') || 'N/A';
    const company = job.company || 'Unknown';
    const source = job.groupName || 'Unknown';
    const text = job.text || '';
    const url = job.submitResult?.formUrl || job.formUrl || job.contacts?.urls?.[0] || 'N/A';
    const coverLetter = job.submitResult?.coverLetter || 'N/A';
    const scoreInfo = `Score: ${job.score || 0}`;
    const errorInfo =
      job.submitResult?.error ||
      (job.submitResult?.step
        ? `step=${job.submitResult.step}; code=${job.submitResult.code || ''}`
        : 'None');

    const rowData = {
      id: job.id,
      date: dateStr,
      status: status,
      role: roles,
      company: company,
      source: source,
      description: text,
      url: url,
      coverLetter: coverLetter,
      score: scoreInfo,
      error: errorInfo
    };

    let row;
    if (rowIndex > 0) {
      // Update existing
      row = worksheet.getRow(rowIndex);
      row.values = rowData;
    } else {
      // Insert new
      row = worksheet.addRow(rowData);
    }

    // Wrap text for better readability
    row.alignment = { wrapText: true, vertical: 'top', horizontal: 'right' };

    await workbook.xlsx.writeFile(TRACKER_FILE);
    if (driveTrackerStatus().configured) {
      void syncTrackerToDrive({
        onLog: (msg) => console.log(msg),
      }).catch((err) => console.error('[tracker] drive sync:', err.message));
    }
  } catch (err) {
    console.error('[tracker] Failed to update Excel tracker:', err.message);
  }
}
