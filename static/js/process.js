import WaveSurfer from "./wavesurfer.esm.js";

const video = document.getElementById("video");
const timestampIndicator = document.querySelector(".timestamp-indicator");
const currentTimestamp = document.getElementById("current-timestamp");
const stepBackButton = document.getElementById("step-back");
const stepForwardButton = document.getElementById("step-forward");
const playBackwardsButton = document.getElementById("play-backwards");
const playForwardsButton = document.getElementById("play-forwards");
const playbackSpeedIndicator = document.getElementById(
  "playback-speed-indicator"
);

const source = video.querySelector("source");
const videoSrc = source.getAttribute("src");
const filename = videoSrc.split("/").pop();

let frameRate = 30; // Default frame rate
let playbackInterval = null;
let playbackSpeedOptions = [-4, -2, -1, 1, 2, 4];
const defaultPlaybackSpeedIndex = 3; // Default to 1x forward
let currentPlaybackSpeedIndex = defaultPlaybackSpeedIndex;
// Fetch the FPS from the server
fetch(`/get_fps/${filename}`)
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

function changePlaybackSpeed(playbackSpeed) {
  clearInterval(playbackInterval);
  if (playbackSpeed < 0) {
    video.pause(); // Pause the video before playing backwards
    playbackInterval = setInterval(() => {
      if (video.currentTime <= 0) {
        clearInterval(playbackInterval);
      } else {
        video.currentTime += playbackSpeed / frameRate;
      }
    }, 1000 / frameRate);
  } else {
    video.playbackRate = playbackSpeed;
    video.play();
  }
  updatePlaybackSpeedIndicator(playbackSpeed);
}

function updatePlaybackSpeedIndicator(playbackSpeed) {
  const direction = playbackSpeed < 0 ? "Backward" : "Forward";
  const speed = Math.abs(playbackSpeed);
  playbackSpeedIndicator.textContent = `Speed: ${speed}x ${direction}`;
}

playBackwardsButton.addEventListener("click", function () {
  currentPlaybackSpeedIndex = Math.max(0, currentPlaybackSpeedIndex - 1);
  const playbackSpeed = playbackSpeedOptions[currentPlaybackSpeedIndex];
  changePlaybackSpeed(playbackSpeed);
});

playForwardsButton.addEventListener("click", function () {
  currentPlaybackSpeedIndex = Math.min(
    playbackSpeedOptions.length - 1,
    currentPlaybackSpeedIndex + 1
  );
  const playbackSpeed = playbackSpeedOptions[currentPlaybackSpeedIndex];
  changePlaybackSpeed(playbackSpeed);
});

video.addEventListener("play", function () {
  currentPlaybackSpeedIndex = defaultPlaybackSpeedIndex;
  const playbackSpeed = playbackSpeedOptions[currentPlaybackSpeedIndex];
  changePlaybackSpeed(playbackSpeed);
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
    <button type="button" class="btn set-clip-start">Set</button>
    <button type="button" class="btn jump-to-clip-start">Jump</button>
    <input type="text" name="clip_end[]" placeholder="End Time" />
    <button type="button" class="btn set-clip-end">Set</button>
    <button type="button" class="btn jump-to-clip-end">Jump</button>
    <button type="button" class="btn remove-clip" aria-label="Remove clip">Remove</button>
  `;
  clipsDiv.appendChild(newClipDiv);
  updateRemoveIndicators();

  // Add event listeners for the new buttons
  newClipDiv
    .querySelector(".set-clip-start")
    .addEventListener("click", function () {
      setClipStart(this);
    });
  newClipDiv
    .querySelector(".jump-to-clip-start")
    .addEventListener("click", function () {
      jumpToClipTime(this, "clip_start[]");
    });
  newClipDiv
    .querySelector(".set-clip-end")
    .addEventListener("click", function () {
      setClipEnd(this);
    });
  newClipDiv
    .querySelector(".jump-to-clip-end")
    .addEventListener("click", function () {
      jumpToClipTime(this, "clip_end[]");
    });

  // Add delete/remove event
  newClipDiv.querySelector(".remove-clip").addEventListener("click", function () {
    // Remove the clip from DOM and update indicators
    newClipDiv.remove();
    updateRemoveIndicators();
  });
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

// Fetch hardware info and populate selector
async function fetchHardware() {
  try {
    const resp = await fetch("/get_hardware");
    const data = await resp.json();
    const detected = data.detected;
    const available = (data.available || []).map((a) => a.toLowerCase());
    const ffmpeg_installed = data.ffmpeg_installed;
    const hardwareIndicator = document.getElementById("hardware-indicator");
    const select = document.getElementById("hardware_select");

    // Show detected hardware + ffmpeg state
    if (!ffmpeg_installed) {
      hardwareIndicator.innerHTML =
        '<span style="color:#b91c1c">ffmpeg not found. Install ffmpeg to enable hardware acceleration.</span>';
      // If ffmpeg is not installed, only CPU should be enabled
      Array.from(select.options).forEach((opt) => {
        if (opt.value !== "cpu" && opt.value !== "auto") {
          opt.disabled = true;
        } else {
          opt.disabled = false;
        }
      });
    } else {
      hardwareIndicator.textContent = "Detected: " + detected;
      // Disable unsupported options if not available
      Array.from(select.options).forEach((opt) => {
        const val = opt.value.toLowerCase();
        const checkVal = val === "intel" ? "qsv" : val;
        if (!available.includes(val) && !available.includes(checkVal)) {
          opt.disabled = true;
        } else {
          opt.disabled = false;
        }
      });
    }

    // Disable unsupported options if not available
    Array.from(select.options).forEach((opt) => {
      // allow auto and cpu always
      if (opt.value === "auto" || opt.value === "cpu") {
        opt.disabled = false;
        return;
      }
      // Map option value to ffmpeg accelerator names
      const val = opt.value.toLowerCase();
      const checkVal = val === "intel" ? "qsv" : val;
      if (!available.includes(val) && !available.includes(checkVal)) {
        opt.disabled = true;
      } else {
        opt.disabled = false;
      }
    });
    // Set the default selection to detected hardware when available
    // Map ffmpeg report to our select values
    const mapping = {
      qsv: "intel",
      cuda: "cuda",
      videotoolbox: "apple",
      vaapi: "vaapi",
    };
    const detectedOption = mapping[detected] || detected;
    // Only set if it's a valid option
    if (Array.from(select.options).some((o) => o.value === detectedOption)) {
      select.value = detectedOption;
    } else {
      select.value = "auto";
    }
  } catch (e) {
    console.error("Failed to fetch hardware info", e);
  }
}

// run at load
fetchHardware();

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
    const clip_start = clip.querySelector('input[name="clip_start[]"]');
    const clip_end = clip.querySelector('input[name="clip_end[]"]');
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

// Fetch peaks data and initialize WaveSurfer
video.addEventListener("loadedmetadata", async function () {
  console.log("Video metadata loaded");

  // Fetch peaks data
  const response = await fetch(`/get_peaks/${filename}`);
  const peaksData = await response.json();

  const wavesurfer = WaveSurfer.create({
    container: "#waveform",
    waveColor: "#2563eb",
    progressColor: "#2563eb",
    cursorColor: "#ee1515",
    backend: "MediaElement",
    mediaControls: false,
    height: 80,
    barWidth: 2,
    cursorWidth: 1,
    hideScrollbar: true,
    media: video, // Pass the video element in the `media` param
    peaks: peaksData.data, // Pass the precomputed peaks data
  });
});

// Add event listeners for the buttons
document
  .querySelector(".btn.set-start-time")
  .addEventListener("click", setStartTime);
document
  .querySelector(".btn.set-end-time")
  .addEventListener("click", setEndTime);
document.querySelector(".btn.add-clip").addEventListener("click", addClip);
document
  .querySelector(".btn.jump-to-start-time")
  .addEventListener("click", function () {
    jumpToTime("start_time");
  });
document
  .querySelector(".btn.jump-to-end-time")
  .addEventListener("click", function () {
    jumpToTime("end_time");
  });

// Validate clip inputs on submit: ensure start and end are filled and valid
document.getElementById("process-form").addEventListener("submit", function (e) {
  // Remove previous highlights
  document.querySelectorAll("input.input-error").forEach((el) => {
    el.classList.remove("input-error");
  });

  // Validate top-level start/end fields
  const topStart = document.getElementById("start_time");
  const topEnd = document.getElementById("end_time");
  const topStartVal = topStart.value.trim();
  const topEndVal = topEnd.value.trim();
  if (!topStartVal || !topEndVal) {
    const missingMsg = [];
    if (!topStartVal) {
      missingMsg.push("Start time is required");
      topStart.classList.add("input-error");
    }
    if (!topEndVal) {
      missingMsg.push("End time is required");
      topEnd.classList.add("input-error");
    }
    alert(missingMsg.join("\n"));
    if (!topStartVal) topStart.focus();
    e.preventDefault();
    return false;
  }

  const topStartNum = Number(topStartVal);
  const topEndNum = Number(topEndVal);
  if (isNaN(topStartNum) || isNaN(topEndNum)) {
    const numMsg = [];
    if (isNaN(topStartNum)) {
      numMsg.push("Start time must be a valid number");
      topStart.classList.add("input-error");
    }
    if (isNaN(topEndNum)) {
      numMsg.push("End time must be a valid number");
      topEnd.classList.add("input-error");
    }
    alert(numMsg.join("\n"));
    if (isNaN(topStartNum)) topStart.focus();
    e.preventDefault();
    return false;
  }

  if (topStartNum >= topEndNum) {
    alert("Start time must be less than end time.");
    topStart.classList.add("input-error");
    topEnd.classList.add("input-error");
    topStart.focus();
    e.preventDefault();
    return false;
  }

  const clipDivs = document.querySelectorAll("#clips .clip");
  let hadError = false;
  let messages = [];
  let realIndex = 0;

  clipDivs.forEach((clip) => {
    const startInput = clip.querySelector('input[name="clip_start[]"]');
    const endInput = clip.querySelector('input[name="clip_end[]"]');
    // If this .clip container doesn't contain any clip inputs, skip (placeholder)
    if (!startInput && !endInput) return;

    realIndex += 1;

    const startVal = startInput ? startInput.value.trim() : "";
    const endVal = endInput ? endInput.value.trim() : "";

    if (!startVal || !endVal) {
      hadError = true;
      messages.push(`Clip ${realIndex} must have both start and end times`);
      if (startInput) startInput.classList.add("input-error");
      if (endInput) endInput.classList.add("input-error");
      return;
    }

    // Optional: validate numeric
    const startNum = Number(startVal);
    const endNum = Number(endVal);
    if (isNaN(startNum) || isNaN(endNum)) {
      hadError = true;
      messages.push(`Clip ${realIndex} has invalid number format`);
      if (startInput && isNaN(startNum)) startInput.classList.add("input-error");
      if (endInput && isNaN(endNum)) endInput.classList.add("input-error");
      return;
    }

    if (startNum >= endNum) {
      hadError = true;
      messages.push(`Clip ${realIndex} start time must be less than end time`);
      startInput.classList.add("input-error");
      endInput.classList.add("input-error");
    }
  });

  if (hadError) {
    alert(messages.join("\n"));
    // Focus first error
    const firstErr = document.querySelector("input.input-error");
    if (firstErr) firstErr.focus();
    e.preventDefault();
    return false;
  }
});
