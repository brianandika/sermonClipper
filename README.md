# VM sermon video processing

This is a Flask web application that allows users to upload a RAW sermon videos and extract the audio and video easily.

## Installation

### Prerequisites

- Python 3.6 or higher
- `ffmpeg` installed and available in your system's PATH

### Steps

1. Clone the repository:

    ```sh
    git clone https://github.com/yourusername/videoclipper.git
    cd videoclipper
    ```

2. Create and activate a virtual environment:

    ```sh
    python -m venv venv
    source venv/bin/activate  # On Windows, use `venv\Scripts\activate`
    ```

3. Install the required Python libraries:

    ```sh
    pip install -r requirements.txt
    ```

4. Run the application:

    ```sh
    python app.py
    ```

5. Open your web browser and go to [http://127.0.0.1:5000](http://127.0.0.1:5000) to use the application.

## Project Structure

- `app.py`: Main application file
- `templates`: HTML templates for the web pages
  - `index.html`: Upload page
  - `process.html`: Video processing page
  - `result.html`: Result page
- `uploads`: Directory for uploaded files
- `processed`: Directory for processed files

## Dependencies
- Flask
- ffmpeg-python
- google-auth-oauthlib
- google-auth-httplib2
- google-api-python-client
- python-dotenv

## Using the Dev Container

This repository can be developed inside a VS Code Dev Container to ensure a consistent environment (Python, tools, and dependencies).

Prerequisites:

- VS Code
- the "Dev Containers" extension (ms-vscode-remote.remote-containers)

Open the project in a dev container:

1. In VS Code open the Command Palette and run **Remote-Containers: Reopen in Container** (or **Dev Containers: Open Folder in Container**).
2. Wait for the container to build and start. The first build may take a few minutes.

Working inside the container:

- The project contains a Python virtual environment at `venv` (created for local runs).

Because virtual environments include system-specific paths and binaries, you should recreate the `venv` inside the dev container instead of reusing a host-created `venv`.

To recreate and activate the virtual environment inside the container:

```bash
rm -rf venv  # optional: remove the host-created venv first
python -m venv venv
source venv/bin/activate
```

If the integrated terminal in VS Code auto-activates a virtual environment, verify it points to a container-local `venv` (not a host path).

- Install Python dependencies (if not already installed in the container):

```bash
pip install -r requirements.txt
```

- Ensure `ffmpeg` is available. If the container image does not include `ffmpeg`, install it inside the container (Debian/Ubuntu example):

```bash
sudo apt update && sudo apt install -y ffmpeg
```

Run the application:

```bash
python app.py
```

Open your browser to http://127.0.0.1:5000. When running in the dev container, accept any prompt to forward the port from the container to the host.

Rebuilding or updating the container:

- If you change devcontainer configuration, rebuild with **Dev Containers: Rebuild Container** from the Command Palette.

Notes:

- The integrated terminal in VS Code may automatically activate the virtual environment for you. If it doesn't, run `source venv/bin/activate`.
- If you prefer not to use the container, the normal local setup in this README still applies.