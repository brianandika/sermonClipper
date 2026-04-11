# Sermon Clipper Web App

Modern React frontend for the Sermon Clipper video editing application.

## Features

- 📹 **Upload Videos** - Select and upload video files
- ✂️ **Timeline Editor** - Mark segments to keep, remove unwanted portions
- 📊 **Job Processing** - Submit jobs to the worker for video/audio processing
- 🎵 **Download Results** - Get processed MP3 audio and MP4 video files

## Architecture

### Component Structure

- **App.tsx** - Main app component managing flow state (upload → editor → results)
- **UploadFlow** - Video upload form with progress tracking
- **EditorFlow** - Timeline editor for marking clips to keep
- **ResultsFlow** - Display processed audio/video results with download links

### API Layer

- **api.ts** - Axios wrapper for all backend API calls
- **types.ts** - TypeScript interfaces for all data models

### Styling

- Uses existing CSS from `/static/css/styles.css` (copied to `public/css/`)
- Responsive grid and flex layouts
- Button, form, and modal styles

## Development

### Prerequisites

- Node.js 18+
- Backend API running on `http://localhost:3000`
- PostgreSQL + Redis (Docker containers)

### Quick Start

```bash
# Install dependencies (if not already done)
npm install --workspace @sermon-clipper/web

# Start dev server (runs on http://localhost:5173)
npm run dev --workspace @sermon-clipper/web

# Build for production
npm run build --workspace @sermon-clipper/web

# Run linter
npm run lint --workspace @sermon-clipper/web
```

### Dev Server Configuration

The Vite dev server (`vite.config.ts`) includes a proxy that forwards API calls:

- `http://localhost:5173/api/*` → `http://localhost:3000/*`

This allows the frontend to make requests to `/api/jobs`, `/api/assets`, etc. instead of full URLs.

## API Integration

### Job Flow

1. **Upload** - POST `/assets/upload` (multipart form data)
2. **Create Job** - POST `/jobs` with asset ID and clip parameters
3. **Poll Job** - GET `/jobs/:id` with exponential backoff until `status === 'completed'`
4. **Fetch Result** - GET `/jobs/:id/result` to get audio/video paths
5. **Download** - Fetch artifacts from `/results/:resultId/audio` and `/results/:resultId/video`

### Clip Format

The editor converts "keep" clip ranges into "remove" ranges for the API:

- User marks ranges like `[10s-20s]` and `[30s-40s]` to keep
- App converts to remove ranges: `[0s-10s]` and `[20s-30s]` and `[40s-end]`
- Sends to API as `clipStarts: [0, 20, 40]` and `clipEnds: [10, 30, end]`

## Known Limitations

- Maximum 30 seconds demo duration (configurable in EditorFlow)
- No hardware acceleration UI (hardcoded to auto-detect in backend)
- No cover image upload in current version
- No audio normalization controls in UI

## Future Enhancements

- Add WaveSurfer.js integration for audio waveform visualization
- Implement hardware acceleration selector UI
- Add cover image upload and preview
- Support batch job creation
- Add job history/management screen
- Implement YouTube direct upload
