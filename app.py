from flask import Flask, render_template, request, redirect, url_for, send_from_directory
import ffmpeg
import os

app = Flask(__name__)
UPLOAD_FOLDER = 'uploads'
PROCESSED_FOLDER = 'processed'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(PROCESSED_FOLDER, exist_ok=True)

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return redirect(request.url)
    file = request.files['file']
    if file.filename == '':
        return redirect(request.url)
    if file:
        filepath = os.path.join(UPLOAD_FOLDER, file.filename)
        file.save(filepath)
        return redirect(url_for('process_file', filename=file.filename))
    return redirect(request.url)

@app.route('/process/<filename>', methods=['GET', 'POST'])
def process_file(filename):
    filepath = os.path.join(UPLOAD_FOLDER, filename)
    if request.method == 'POST':
        start_time = float(request.form['start_time'])
        end_time = float(request.form['end_time'])
        cross_dissolve_duration = 1  # Duration of the cross dissolve effect in seconds
        output_video_path = os.path.join(PROCESSED_FOLDER, f"clipped_{filename}")
        output_audio_path = os.path.join(PROCESSED_FOLDER, f"{os.path.splitext(filename)[0]}.mp3")
        
        # Clip video with cross dissolve effect
        input_video = ffmpeg.input(filepath, ss=start_time, to=end_time)
        video = (
            input_video
            .filter('fade', type='in', start_time=0, duration=cross_dissolve_duration)
            .filter('fade', type='out', start_time=end_time-start_time-cross_dissolve_duration, duration=cross_dissolve_duration)
        )
        audio = input_video.audio
        ffmpeg.output(video, audio, output_video_path).overwrite_output().run()
        
        # Extract audio
        ffmpeg.input(output_video_path).output(output_audio_path, acodec='libmp3lame').overwrite_output().run()
        
        return render_template('result.html', video_filename=f"clipped_{filename}", audio_filename=f"{os.path.splitext(filename)[0]}.mp3")
    return render_template('process.html', filename=filename)

@app.route('/uploads/<filename>')
def uploaded_file(filename):
    return send_from_directory(UPLOAD_FOLDER, filename)

@app.route('/processed/<filename>')
def processed_file(filename):
    return send_from_directory(PROCESSED_FOLDER, filename)

if __name__ == '__main__':
    app.run(debug=True)