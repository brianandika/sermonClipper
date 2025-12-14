// YouTube Upload Manager
class YouTubeUploadManager {
  constructor() {
    this.accessToken = null;
    this.videoFilename = this.extractVideoFilename();
    this.isAuthenticated = false;

    this.initializeElements();
    this.setupEventListeners();
    this.checkAuthStatus();
    this.checkForAuthCallback();
    
    // Auto-fill title if video filename exists
    if (this.videoFilename) {
      this.setTitleFromFilename(this.videoFilename);
    }
  }

  initializeElements() {
    this.authButton = document.getElementById("auth-button");
    this.logoutButton = document.getElementById("logout-button");
    this.authStatus = document.getElementById("auth-status");
    this.authSection = document.getElementById("auth-section");
    this.uploadSection = document.getElementById("upload-section");
    this.uploadForm = document.getElementById("youtube-upload-form");
    this.submitButton = document.getElementById("submit-button");
    this.progressContainer = document.getElementById("progress-container");
    this.progressFill = document.getElementById("progress-fill");
    this.progressMessage = document.getElementById("progress-message");
    this.messageDiv = document.getElementById("message");
    this.titleInput = document.getElementById("title");
    this.manualVideoSection = document.getElementById("manual-video-section");
    this.manualVideoInput = document.getElementById("manual-video-input");
    this.manualVideoButton = document.getElementById("manual-video-button");
    this.manualVideoInfo = document.getElementById("manual-video-info");
    this.manualVideoName = document.getElementById("manual-video-name");
    this.playlistContainer = document.getElementById("playlist-container");
    this.refreshPlaylistsButton = document.getElementById("refresh-playlists");
    this.playlistError = document.getElementById("playlist-error");
    this.authWidget = document.getElementById("auth-widget");
    this.authWidgetStatus = document.getElementById("auth-widget-status");
    this.authWidgetLogout = document.getElementById("auth-widget-logout");
  }

  setupEventListeners() {
    this.authButton.addEventListener("click", () => this.handleAuth());
    this.logoutButton.addEventListener("click", () => this.handleLogout());
    this.authWidgetLogout.addEventListener("click", () => this.handleLogout());
    this.uploadForm.addEventListener("submit", (e) => this.handleUpload(e));
    this.manualVideoButton.addEventListener("click", () => this.manualVideoInput.click());
    this.manualVideoInput.addEventListener("change", (e) => this.handleManualVideoSelect(e));
    this.refreshPlaylistsButton.addEventListener("click", () => this.loadPlaylists());
  }

  extractVideoFilename() {
    // Get the video filename from the page if it exists
    const fileInfo = document.querySelector(".file-info");
    if (fileInfo) {
      const text = fileInfo.textContent;
      // Match filename with spaces - captures everything after "📹 Video File:" until end of line/string
      // This handles filenames with spaces like "clipped_P. Young Video for Retreat.MOV"
      const match = text.match(/📹\s*Video File:\s*(.+\.(?:mp4|mov|avi|mkv))/i);
      return match ? match[1].trim() : null;
    }
    return null;
  }

  filenameToTitle(filename) {
    if (!filename) return "";
    
    // Remove file extension
    return filename.replace(/\.[^/.]+$/, "");
  }

  setTitleFromFilename(filename) {
    if (filename && this.titleInput) {
      const title = this.filenameToTitle(filename);
      if (title && !this.titleInput.value) {
        this.titleInput.value = title;
      }
    }
  }

  async handleManualVideoSelect(event) {
    const file = event.target.files[0];
    if (file) {
      try {
        // Show loading state
        this.manualVideoButton.disabled = true;
        this.manualVideoButton.textContent = "Uploading...";
        this.manualVideoInfo.style.display = "none";
        
        // Upload the file to the server
        const formData = new FormData();
        formData.append("file", file);
        
        const response = await fetch("/youtube/upload-manual-video", {
          method: "POST",
          body: formData,
        });
        
        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || "Upload failed");
        }
        
        const result = await response.json();
        
        // Set the video filename to the uploaded file's name
        this.videoFilename = result.filename;
        this.manualVideoName.textContent = result.filename;
        this.manualVideoInfo.style.display = "block";
        
        // Auto-fill title from filename
        this.setTitleFromFilename(result.filename);
        
        this.showMessage("success", `Manual video uploaded: ${result.filename}. You can now upload to YouTube.`);
      } catch (error) {
        console.error("Manual video upload error:", error);
        this.showMessage("error", `Failed to upload manual video: ${error.message}`);
        this.manualVideoInput.value = ""; // Clear the input
      } finally {
        this.manualVideoButton.disabled = false;
        this.manualVideoButton.textContent = "Select Manual Video";
      }
    }
  }

  checkAuthStatus() {
    // Check if we have a stored access token in session/cookies
    fetch("/youtube/auth-status")
      .then((response) => response.json())
      .then((data) => {
        if (data.authenticated) {
          this.accessToken = data.access_token;
          this.setAuthenticated(true);
        }
      })
      .catch((error) => console.log("Auth status check failed:", error));
  }

  checkForAuthCallback() {
    // Check if we're returning from Google OAuth callback
    const params = new URLSearchParams(window.location.search);
    if (params.has("code")) {
      this.showMessage("info", "Processing authentication...");
      // The server will handle the code exchange automatically
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }

  handleAuth() {
    // Redirect to backend OAuth endpoint
    window.location.href = "/youtube/auth";
  }

  handleLogout() {
    fetch("/youtube/logout", { method: "POST" })
      .then((response) => response.json())
      .then((data) => {
        this.accessToken = null;
        this.setAuthenticated(false);
        this.showMessage("info", "You have been logged out.");
      })
      .catch((error) => {
        console.error("Logout error:", error);
        this.showMessage("error", "Logout failed");
      });
  }

  setAuthenticated(authenticated) {
    this.isAuthenticated = authenticated;

    if (authenticated) {
      // Update main auth section
      this.authStatus.textContent = "✅ Authenticated";
      this.authStatus.classList.remove("not-authenticated");
      this.authStatus.classList.add("authenticated");
      this.authButton.style.display = "none";
      this.logoutButton.style.display = "inline-block";
      
      // Hide main auth section, show top-right widget
      this.authSection.classList.add("authenticated-hidden");
      this.authWidget.classList.add("visible");
      
      // Update top-right widget
      this.authWidgetStatus.textContent = "✅ Authenticated";
      this.authWidgetStatus.classList.remove("not-authenticated");
      this.authWidgetStatus.classList.add("authenticated");
      this.authWidgetLogout.style.display = "block";
      
      // Show upload section and manual video section
      this.uploadSection.style.display = "block";
      this.manualVideoSection.style.display = "block";
      
      // Load playlists when authenticated
      this.loadPlaylists();
    } else {
      // Update main auth section
      this.authStatus.textContent = "❌ Not Authenticated";
      this.authStatus.classList.remove("authenticated");
      this.authStatus.classList.add("not-authenticated");
      this.authButton.style.display = "inline-block";
      this.logoutButton.style.display = "none";
      
      // Show main auth section, hide top-right widget
      this.authSection.classList.remove("authenticated-hidden");
      this.authWidget.classList.remove("visible");
      
      // Update top-right widget
      this.authWidgetStatus.textContent = "❌ Not Authenticated";
      this.authWidgetStatus.classList.remove("authenticated");
      this.authWidgetStatus.classList.add("not-authenticated");
      this.authWidgetLogout.style.display = "none";
      
      // Hide upload section and manual video section
      this.uploadSection.style.display = "none";
      this.manualVideoSection.style.display = "none";
      
      // Clear playlists when logged out
      this.playlistContainer.innerHTML = '<div class="playlist-loading">Please authenticate to load playlists.</div>';
    }
  }

  async loadPlaylists() {
    if (!this.isAuthenticated) {
      return;
    }

    try {
      this.refreshPlaylistsButton.disabled = true;
      this.refreshPlaylistsButton.textContent = "Loading...";

      const response = await fetch("/youtube/playlists", {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      });

      if (!response.ok) {
        throw new Error("Failed to load playlists");
      }

      const data = await response.json();
      
      // Clear existing checkboxes
      this.playlistContainer.innerHTML = '';
      
      // Add playlists as checkboxes
      if (data.playlists && data.playlists.length > 0) {
        data.playlists.forEach((playlist) => {
          const item = document.createElement("div");
          item.className = "playlist-item";
          
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.value = playlist.id;
          checkbox.name = "playlist";
          checkbox.id = `playlist-${playlist.id}`;
          
          const label = document.createElement("label");
          label.htmlFor = `playlist-${playlist.id}`;
          label.textContent = `${playlist.title} (${playlist.itemCount} videos)`;
          
          item.appendChild(checkbox);
          item.appendChild(label);
          this.playlistContainer.appendChild(item);
        });
      } else {
        const div = document.createElement("div");
        div.className = "playlist-loading";
        div.textContent = "No playlists found";
        this.playlistContainer.appendChild(div);
      }
    } catch (error) {
      console.error("Error loading playlists:", error);
      this.showMessage("error", "Failed to load playlists. Please try again.");
    } finally {
      this.refreshPlaylistsButton.disabled = false;
      this.refreshPlaylistsButton.textContent = "Refresh Playlists";
    }
  }

  async handleUpload(event) {
    event.preventDefault();

    if (!this.isAuthenticated) {
      this.showMessage("error", "Please authenticate first.");
      return;
    }

    if (!this.videoFilename) {
      this.showMessage(
        "error",
        "No video file found. Please process a video first."
      );
      return;
    }

    // Disable submit button and show progress
    this.submitButton.disabled = true;
    this.progressContainer.style.display = "block";
    this.messageDiv.className = "message";
    this.messageDiv.textContent = "";

    try {
      // Get form data
      const title = document.getElementById("title").value;
      const description = document.getElementById("description").value;
      const visibility = document.querySelector(
        'input[name="visibility"]:checked'
      ).value;
      
      // Get all selected playlists
      const playlistCheckboxes = this.playlistContainer.querySelectorAll('input[type="checkbox"]:checked');
      const playlistIds = Array.from(playlistCheckboxes).map(cb => cb.value);

      // Validate required fields
      if (!title) {
        this.showMessage("error", "Please enter a video title.");
        this.submitButton.disabled = false;
        this.progressContainer.style.display = "none";
        return;
      }

      if (!description || description.trim() === "") {
        this.showMessage("error", "Please enter a video description.");
        this.submitButton.disabled = false;
        this.progressContainer.style.display = "none";
        return;
      }

      if (playlistIds.length === 0) {
        this.showMessage("error", "Please select at least one playlist.");
        this.playlistError.style.display = "block";
        this.submitButton.disabled = false;
        this.progressContainer.style.display = "none";
        return;
      }
      
      this.playlistError.style.display = "none";

      // Call backend to upload to YouTube
      this.progressMessage.textContent = "Uploading to YouTube...";
      this.updateProgress(10);

      const response = await fetch("/youtube/upload", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify({
          filename: this.videoFilename,
          title: title,
          description: description,
          visibility: visibility,
          playlist_ids: playlistIds,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Upload failed");
      }

      const result = await response.json();

      this.updateProgress(100);
      let successMessage = `Video uploaded successfully! Video ID: ${result.video_id}`;
      if (result.added_to_playlists) {
        successMessage += ` (Added to ${result.playlists_added} playlist${result.playlists_added > 1 ? 's' : ''})`;
      }
      
      this.progressMessage.innerHTML = `
        <strong>✅ Upload Successful!</strong><br>
        Video ID: <a href="https://www.youtube.com/watch?v=${result.video_id}" target="_blank">${result.video_id}</a><br>
        ${result.added_to_playlists ? `<span style="color: #28a745;">✓ Added to ${result.playlists_added} playlist${result.playlists_added > 1 ? 's' : ''}</span><br>` : ''}
        <a href="https://www.youtube.com/watch?v=${result.video_id}" target="_blank" class="btn btn-primary" style="margin-top: 10px; display: inline-block;">Watch on YouTube</a>
      `;

      this.showMessage("success", successMessage);
      this.uploadForm.reset();
    } catch (error) {
      this.updateProgress(0);
      this.progressMessage.textContent = "Upload failed";
      this.showMessage("error", `Upload failed: ${error.message}`);
      console.error("Upload error:", error);
    } finally {
      this.submitButton.disabled = false;
    }
  }

  updateProgress(percent) {
    this.progressFill.style.width = percent + "%";
    this.progressFill.textContent = percent + "%";
  }

  showMessage(type, message) {
    this.messageDiv.className = `message ${type}`;
    this.messageDiv.textContent = message;
  }

}

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  new YouTubeUploadManager();
});
