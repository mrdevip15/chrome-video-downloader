/**
 * Converts WebVTT string format to SubRip (.srt) format.
 */
function vttToSrt(vttContent) {
  if (!vttContent) return '';

  let lines = vttContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // Strip WEBVTT header and NOTE blocks
  let startIdx = 0;
  while (startIdx < lines.length) {
    const line = lines[startIdx].trim();
    if (line.startsWith('WEBVTT') || line.startsWith('NOTE') || line === '') {
      startIdx++;
    } else {
      break;
    }
  }

  const cues = [];
  let currentCue = [];

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      if (currentCue.length > 0) {
        cues.push(currentCue);
        currentCue = [];
      }
    } else {
      currentCue.push(line);
    }
  }
  if (currentCue.length > 0) cues.push(currentCue);

  let srtResult = '';
  let counter = 1;

  for (const cue of cues) {
    let timeIndex = -1;
    for (let j = 0; j < cue.length; j++) {
      if (cue[j].includes('-->')) {
        timeIndex = j;
        break;
      }
    }

    if (timeIndex === -1) continue;

    // Convert timestamps: 00:00:00.000 or 00:00.000 to 00:00:00,000
    let timestampLine = cue[timeIndex];
    timestampLine = timestampLine.replace(/(\d{2}:\d{2})\.(\d{3})/g, '00:$1,$2');
    timestampLine = timestampLine.replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, '$1,$2');
    // Remove positioning metadata after timestamp (e.g. line:0% position:50%)
    timestampLine = timestampLine.replace(/-->\s*([0-9:,]+).*/, '--> $1');

    const textLines = cue.slice(timeIndex + 1);

    srtResult += `${counter}\n`;
    srtResult += `${timestampLine}\n`;
    srtResult += `${textLines.join('\n')}\n\n`;
    counter++;
  }

  return srtResult.trim() + '\n';
}

function sanitizePath(name) {
  if (!name) return 'untitled';
  return name.replace(/[\\/:*?"<>|]/g, '_').trim();
}

window.CourseFormatter = {
  vttToSrt,
  sanitizePath
};
