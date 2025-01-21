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
        clip_start = request.form.getlist('clip_start[]')
        clip_end = request.form.getlist('clip_end[]')
        print(clip_start)
        print(type(clip_start))
        print(len(clip_start))
        print(clip_end)
        cross_dissolve_duration = 1  # Duration of the cross dissolve effect in seconds
        output_video_path = os.path.join(PROCESSED_FOLDER, f"clipped_{filename}")
        output_audio_path = os.path.join(PROCESSED_FOLDER, f"{os.path.splitext(filename)[0]}.mp3")

        if len(clip_start) > 0 and len(clip_end) > 0 and len(clip_start) == len(clip_end):
           clip_start = [float(x) for x in clip_start]
           clip_end = [float(x) for x in clip_end]
        else :
            clip_start = None
            clip_end = None

        # get number of segments
        num_segments = 1
        if clip_start and clip_end:
            num_segments = len(clip_start) + 1

        # Load input
        input_file = ffmpeg.input(filepath, ss=start_time, to=end_time)

        if num_segments == 1:
            final_video = (input_file.video
                 .filter('fade', type='in', start_time=0, duration=cross_dissolve_duration)
                 .filter('fade', type='out',
                         start_time=(end_time - start_time - cross_dissolve_duration),
                         duration=cross_dissolve_duration)
                )
            final_audio = (input_file.audio
                 .filter('afade', t='in', st=0, d=cross_dissolve_duration)
                 .filter('afade', t='out',
                         st=(end_time - start_time - cross_dissolve_duration),
                         d=cross_dissolve_duration)
                )
        else:
            input_video_s = input_file.video
            input_audio_s = input_file.audio

            final_video_seg = []
            final_audio_seg = [] 
            for i in range(num_segments):
                if i == 0:
                    final_video_seg.append(input_video_s.filter('trim', start=start_time, end=clip_start[0]).filter('setpts', 'PTS-STARTPTS'))
                    final_audio_seg.append(input_audio_s.filter('atrim', start=start_time, end=clip_start[0]).filter('asetpts', 'PTS-STARTPTS'))
                elif i == num_segments - 1:
                    final_video_seg.append(input_video_s.filter('trim', start=clip_end[i-1], end=end_time).filter('setpts', 'PTS-STARTPTS'))
                    final_audio_seg.append(input_audio_s.filter('atrim', start=clip_end[i-1], end=end_time).filter('asetpts', 'PTS-STARTPTS'))
                else:
                    final_video_seg.append(input_video_s.filter('trim', start=clip_end[i-1], end=clip_start[i]).filter('setpts', 'PTS-STARTPTS'))
                    final_audio_seg.append(input_audio_s.filter('atrim', start=clip_end[i-1], end=clip_start[i]).filter('asetpts', 'PTS-STARTPTS'))
            
            # Concatenate video and audio
            print(final_video_seg)
            print(final_audio_seg)
            print(num_segments)
            final_video = ffmpeg.concat(*final_video_seg, n=num_segments, v=1, a=0)
            final_audio = ffmpeg.concat(*final_audio_seg, n=num_segments, v=0, a=1)

        ffmpeg.output(final_video, final_audio, output_video_path).overwrite_output().run()
        
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