document
  .getElementById("upload-form")
  .addEventListener("submit", function (event) {
    event.preventDefault();
    document.getElementById("progress-modal").style.display = "block";
    uploadFile(new FormData(this));
  });

function uploadFile(formData) {
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/upload", true);

  xhr.upload.onprogress = function (event) {
    if (event.lengthComputable) {
      const percentComplete = (event.loaded / event.total) * 100;
      document.querySelector(".progress").style.width = percentComplete + "%";
    }
  };

  xhr.onload = function () {
    if (xhr.status === 200) {
      window.location.href = xhr.responseURL;
    } else {
      alert("Upload failed!");
      document.getElementById("progress-modal").style.display = "none";
    }
  };

  xhr.send(formData);
}

// Fetch and display hardware on main page
async function fetchHardwareMain() {
  try {
    const resp = await fetch("/get_hardware");
    const data = await resp.json();
    const detected = data.detected;
    const available = data.friendly || data.available || [];
    const ffmpeg_installed = data.ffmpeg_installed;
    const el = document.getElementById("hardware-indicator-main");
    if (!ffmpeg_installed) {
      el.innerHTML =
        '<span style="color:#b91c1c">ffmpeg not found — install ffmpeg for hardware acceleration. See https://ffmpeg.org/download.html</span>';
    } else {
      el.textContent = `Hardware: ${detected} — Available: ${available.join(", ")}`;
    }
  } catch (e) {
    console.error("Failed to fetch hardware info", e);
  }
}

fetchHardwareMain();
