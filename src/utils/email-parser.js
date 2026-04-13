// Extract the original message from a forwarded email chain.
// Strips out forwarding metadata, quoted replies, signatures, etc.

const FWD_MARKERS = [
  /-{2,}\s*Forwarded message\s*-{2,}/i,
  /-{2,}\s*Original Message\s*-{2,}/i,
  /Begin forwarded message:/i,
];

const REPLY_MARKERS = [
  /^On .+ wrote:$/im,
  /^From:\s.+$/im,
];

function cleanForwardedEmail(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw.trim();

  // Strip forwarding headers by slicing after the marker block
  for (const marker of FWD_MARKERS) {
    const match = text.match(marker);
    if (match) {
      // Take everything AFTER the header block (after From:, To:, Subject:, Date: lines)
      const startIdx = match.index + match[0].length;
      let rest = text.slice(startIdx);
      // Strip lines like "From:", "To:", "Subject:", "Date:", "Sent:"
      rest = rest.replace(/^(From|To|Subject|Date|Sent|Cc|Bcc):.*$/gim, '').trim();
      text = rest;
      break;
    }
  }

  // Remove quoted reply lines starting with ">"
  text = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n');

  // Cut at "On [date] [person] wrote:" markers
  for (const marker of REPLY_MARKERS) {
    const match = text.match(marker);
    if (match) text = text.slice(0, match.index).trim();
  }

  // Strip common signature separators
  text = text.split(/^-- $/m)[0];

  return text.replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { cleanForwardedEmail };
