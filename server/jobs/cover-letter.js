/**
 * Cover letter builder — prefers LLM adaptation, falls back to profile templates.
 */

/**
 * @param {object} opts
 * @param {object} opts.profile
 * @param {string} opts.jobText
 * @param {string} [opts.coverNote]
 * @param {boolean} [opts.useLlm]
 * @param {(prompt: string) => Promise<string>} [opts.llmGenerate]
 */
export async function buildCoverLetter({
  profile,
  jobText,
  coverNote,
  useLlm = true,
  llmGenerate,
} = {}) {
  if (coverNote != null && String(coverNote).trim()) {
    return { text: String(coverNote).trim(), source: 'explicit' };
  }

  const useHe = /[\u0590-\u05FF]/.test(String(jobText || ''));
  const name = profile?.name || 'Candidate';
  const roles = (profile?.targetRoles || []).join(', ') || 'Full Stack / Backend';

  if (useLlm && typeof llmGenerate === 'function') {
    try {
      const prompt = [
        'Write a short professional cover note (max 120 words) for a job application.',
        `Candidate name: ${name}`,
        `Candidate roles: ${roles}`,
        `LinkedIn: ${profile?.linkedin || 'n/a'}`,
        `GitHub: ${profile?.github || 'n/a'}`,
        `Language: ${useHe ? 'Hebrew' : 'English'}`,
        'Job post:',
        String(jobText || '').slice(0, 1200),
        'Return only the cover note body, no markdown.',
      ].join('\n');
      const text = String(await llmGenerate(prompt)).trim();
      if (text) return { text, source: 'llm' };
    } catch {
      /* fall through to template */
    }
  }

  const template =
    (useHe ? profile?.coverTemplateHe : profile?.coverTemplateEn) ||
    profile?.coverTemplateEn ||
    profile?.coverTemplateHe ||
    (useHe
      ? 'שלום,\n\nראיתי את המשרה ומצורפים קורות החיים שלי.\nאשמח להמשיך.\n\n{name}'
      : 'Hello,\n\nI saw the role and am attaching my CV.\nHappy to continue.\n\n{name}');

  const text = String(template)
    .replaceAll('{name}', name)
    .replaceAll('{roles}', roles)
    .trim();
  return { text, source: 'template' };
}
