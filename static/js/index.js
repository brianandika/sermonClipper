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
