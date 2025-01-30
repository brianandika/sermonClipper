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