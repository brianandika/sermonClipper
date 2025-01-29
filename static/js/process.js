const video = document.getElementById("video");
const timestampIndicator = document.querySelector(".timestamp-indicator");
const currentTimestamp = document.getElementById("current-timestamp");
const stepBackButton = document.getElementById("step-back");
const stepForwardButton = document.getElementById("step-forward");

let frameRate = 30; // Default frame rate

// Fetch the FPS from the server
fetch(`/get_fps/{{ filename }}`)
  .then((response) => response.json())
  .then((data) => {
    frameRate = data.fps;
    console.log(`Frame rate: ${frameRate} fps`);
  });

video.addEventListener("timeupdate", function () {
  const currentTime = video.currentTime;
  const duration = video.duration;
  const percentage = (currentTime / duration) * 100;
  timestampIndicator.style.left = percentage + "%";
  currentTimestamp.textContent = formatTime(currentTime);
});

stepBackButton.addEventListener("click", function () {
  video.pause();
  video.currentTime = Math.max(0, video.currentTime - 1 / frameRate); // Step back by one frame
});

stepForwardButton.addEventListener("click", function () {
  video.pause();
  video.currentTime = Math.min(
    video.duration,
    video.currentTime + 1 / frameRate
  ); // Step forward by one frame
});

function formatTime(seconds) {
  const date = new Date(0);
  date.setMilliseconds(seconds * 1000);
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const secs = String(date.getUTCSeconds()).padStart(2, "0");
  const millis = String(date.getUTCMilliseconds()).padStart(3, "0");
  return `${hours}:${minutes}:${secs}.${millis}`;
}

function setStartTime() {
  document.getElementById("start_time").value = video.currentTime.toFixed(3);
  updateRemoveIndicators();
}

function setEndTime() {
  document.getElementById("end_time").value = video.currentTime.toFixed(3);
  updateRemoveIndicators();
}

function addClip() {
  const clipsDiv = document.getElementById("clips");
  const newClipDiv = document.createElement("div");
  newClipDiv.classList.add("clip", "flex", "centered");
  newClipDiv.innerHTML = `
    <input type="text" name="clip_start[]" placeholder="Start Time" />
    <button type="button" class="btn" onclick="setClipStart(this)">Set</button>
    <button type="button" class="btn" onclick="jumpToClipTime(this, 'clip_start[]')">Jump</button>
    <input type="text" name="clip_end[]" placeholder="End Time" />
    <button type="button" class="btn" onclick="setClipEnd(this)">Set</button>
    <button type="button" class="btn" onclick="jumpToClipTime(this, 'clip_end[]')">Jump</button>
  `;
  clipsDiv.appendChild(newClipDiv);
  updateRemoveIndicators();
}

function setClipStart(button) {
  const parent = button.parentElement;
  const input = parent.querySelector('input[name="clip_start[]"]');
  if (input) {
    input.value = video.currentTime.toFixed(3);
  }
  updateRemoveIndicators();
}

function setClipEnd(button) {
  const parent = button.parentElement;
  const input = parent.querySelector('input[name="clip_end[]"]');
  if (input) {
    input.value = video.currentTime.toFixed(3);
  }
  updateRemoveIndicators();
}

function jumpToClipTime(button, inputName) {
  const parent = button.parentElement;
  const input = parent.querySelector(`input[name="${inputName}"]`);
  const time = parseFloat(input.value);
  if (!isNaN(time)) {
    video.currentTime = time;
  }
}

function jumpToTime(inputId) {
  const timeInput = document.getElementById(inputId);
  const time = parseFloat(timeInput.value);
  if (!isNaN(time)) {
    video.currentTime = time;
  }
}

// Poll the status endpoint to update the progress bar
function checkProcessingStatus() {
  fetch("/status")
    .then((response) => response.json())
    .then((data) => {
      const progress = data.progress;
      const progress_message = data.progress_message;
      const processing = data.processing;

      if (processing) {
        document.getElementById("progress-modal").style.display = "block";
        document.querySelector(".progress").style.width = progress + "%";
        document.getElementById("progress-title").innerText = progress_message;
      } else {
        document.getElementById("progress-modal").style.display = "none";
      }

      setTimeout(checkProcessingStatus, 500);
    });
}

// Initial check for processing status
checkProcessingStatus();

const removeIndicatorStart = document.querySelector(".remove-indicator.start");
const removeIndicatorEnd = document.querySelector(".remove-indicator.end");
const clipIndicators = document.getElementById("clip-indicators");

function updateRemoveIndicators() {
  const startTime =
    parseFloat(document.getElementById("start_time").value) || 0;
  const endTime =
    parseFloat(document.getElementById("end_time").value) || video.duration;

  const startPercentage = (startTime / video.duration) * 100;
  const endPercentage = ((video.duration - endTime) / video.duration) * 100;

  removeIndicatorStart.style.width = startPercentage + "%";
  removeIndicatorEnd.style.width = endPercentage + "%";

  // Clear existing clip indicators
  clipIndicators.innerHTML = "";

  // Create new clip indicators
  const clips = document.querySelectorAll(".clip");
  clips.forEach((clip) => {
    clip_start = clip.querySelector('input[name="clip_start[]"]');
    clip_end = clip.querySelector('input[name="clip_end[]"]');
    if (!clip_start || !clip_end) {
      return;
    }
    const clipStart = parseFloat(clip_start.value) || 0;
    const clipEnd = parseFloat(clip_end.value) || 0;
    const clipStartPercentage = (clipStart / video.duration) * 100;
    const clipEndPercentage = (clipEnd / video.duration) * 100;
    const clipWidth = clipEndPercentage - clipStartPercentage;

    const clipIndicator = document.createElement("div");
    clipIndicator.classList.add("remove-indicator", "clip");
    clipIndicator.style.left = clipStartPercentage + "%";
    clipIndicator.style.width = clipWidth + "%";
    clipIndicators.appendChild(clipIndicator);
  });
}

document
  .getElementById("start_time")
  .addEventListener("input", updateRemoveIndicators);
document
  .getElementById("end_time")
  .addEventListener("input", updateRemoveIndicators);
document
  .getElementById("clips")
  .addEventListener("input", updateRemoveIndicators);

video.addEventListener("loadedmetadata", updateRemoveIndicators);
