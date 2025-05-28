import express from 'express';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';
import cors from 'cors';
import ytsr from 'ytsr';
import dotenv from 'dotenv';

dotenv.config();
const execAsync = promisify(exec);
const app = express();
const port = process.env.PORT || 5000;

// SOLUTION 1: Use system espeak command directly (RECOMMENDED)
async function speakWithSystemEspeak(text) {
  try {
    const escapedText = text.replace(/"/g, '\\"').replace(/'/g, "\\'");
    
    if (process.platform === 'linux') {
      // Linux with espeak
      await execAsync(`espeak "${escapedText}"`);
    } else if (process.platform === 'darwin') {
      // macOS with say command
      await execAsync(`say "${escapedText}"`);
    } else if (process.platform === 'win32') {
      // Windows with PowerShell
      await execAsync(`powershell -Command "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${escapedText}')"`);
    }
    
    return { success: true };
  } catch (error) {
    throw new Error(`Failed to speak: ${error.message}`);
  }
}

// SOLUTION 2: Generate WAV file and play it
async function speakWithWavGeneration(text) {
  try {
    const escapedText = text.replace(/"/g, '\\"');
    const wavFile = `/tmp/speech_${Date.now()}.wav`;
    
    // Generate WAV file
    await execAsync(`espeak "${escapedText}" -w "${wavFile}"`);
    
    // Play the WAV file
    if (process.platform === 'linux') {
      // Try different audio players
      try {
        await execAsync(`aplay "${wavFile}"`);
      } catch {
        try {
          await execAsync(`paplay "${wavFile}"`);
        } catch {
          await execAsync(`play "${wavFile}"`);
        }
      }
    } else if (process.platform === 'darwin') {
      await execAsync(`afplay "${wavFile}"`);
    } else if (process.platform === 'win32') {
      await execAsync(`powershell -c "(New-Object Media.SoundPlayer '${wavFile}').PlaySync()"`);
    }
    
    // Clean up the file
    setTimeout(() => {
      exec(`rm "${wavFile}"`, () => {});
    }, 1000);
    
    return { success: true };
  } catch (error) {
    throw new Error(`Failed to speak with WAV generation: ${error.message}`);
  }
}

// SOLUTION 3: Use espeak with ALSA/PulseAudio configuration
async function speakWithAudioConfig(text) {
  try {
    const escapedText = text.replace(/"/g, '\\"');
    
    // Set audio environment variables
    const audioEnv = {
      ...process.env,
      DISPLAY: process.env.DISPLAY || ':0',
      PULSE_RUNTIME_PATH: process.env.PULSE_RUNTIME_PATH || '/run/user/1000/pulse',
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '/run/user/1000'
    };
    
    await execAsync(`espeak "${escapedText}"`, { env: audioEnv });
    return { success: true };
  } catch (error) {
    throw new Error(`Failed to speak with audio config: ${error.message}`);
  }
}

// Main speak function with multiple fallbacks
async function speakText(text) {
  const methods = [
    { name: 'System Espeak', func: speakWithSystemEspeak },
    { name: 'WAV Generation', func: speakWithWavGeneration },
    { name: 'Audio Config', func: speakWithAudioConfig }
  ];
  
  let lastError;
  
  for (const method of methods) {
    try {
      console.log(`Trying ${method.name}...`);
      await method.func(text);
      console.log(`${method.name} succeeded`);
      return { success: true, method: method.name };
    } catch (error) {
      console.log(`${method.name} failed:`, error.message);
      lastError = error;
    }
  }
  
  throw lastError || new Error('All speech methods failed');
}

// Middleware
app.use(cors());
app.use(express.json());

// Route to open an app
app.post('/api/open-app', (req, res) => {
  const { appName } = req.body;
  
  // Sanitize appName to prevent injection
  const sanitizedAppName = appName.replace(/[^a-zA-Z0-9-_]/g, '');
  
  if (!sanitizedAppName) {
    return res.status(400).json({ error: 'Invalid app name' });
  }

  let command;
  if (process.platform === 'darwin') {
    command = `open -a "${sanitizedAppName}"`;
  } else if (process.platform === 'win32') {
    command = `start ${sanitizedAppName}`;
  } else if (process.platform === 'linux') {
    command = `${sanitizedAppName} &`;
  } else {
    return res.status(400).json({ error: 'Unsupported OS' });
  }

  if (process.platform === 'linux') {
    exec(`which ${sanitizedAppName}`, (error, stdout) => {
      if (error || !stdout) {
        return res.status(404).json({ error: `Application ${sanitizedAppName} not found` });
      }
      exec(command, { env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' } }, (error) => {
        if (error) {
          return res.status(500).json({ error: `Failed to open ${sanitizedAppName}: ${error.message}` });
        }
        res.json({ message: `${sanitizedAppName} opened successfully` });
      });
    });
  } else {
    exec(command, (error) => {
      if (error) {
        return res.status(500).json({ error: `Failed to open ${sanitizedAppName}: ${error.message}` });
      }
      res.json({ message: `${sanitizedAppName} opened successfully` });
    });
  }
});

// Route to fetch news
app.get('/api/news', async (req, res) => {
  try {
    let response = await axios.get('https://newsapi.org/v2/top-headlines', {
      params: {
        country: 'in',
        apiKey: process.env.NEWS_API_KEY,
      },
    });

    let articles = response.data.articles;

    // Fallback to general query
    if (!articles || articles.length === 0) {
      response = await axios.get('https://newsapi.org/v2/everything', {
        params: {
          q: 'india',
          apiKey: process.env.NEWS_API_KEY,
        },
      });
      articles = response.data.articles;
    }

    if (!articles || articles.length === 0) {
      return res.status(404).json({ error: 'No news articles found. Check your News API key.' });
    }

    // Return top 5 titles and URLs
    const news = articles.slice(0, 5).map(article => ({
      title: article.title,
      url: article.url,
    }));

    res.json({ articles: news });
  } catch (error) {
    res.status(500).json({ error: `Failed to fetch news: ${error.message}` });
  }
});

// Route to query Gemini API
app.post('/api/gemini', async (req, res) => {
  const { query } = req.body;

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: query }] }],
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    // Clean and limit response
    const text = response.data.candidates[0].content.parts[0].text
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .split(' ')
      .slice(0, 40)
      .join(' ');

    res.json({ response: text });
  } catch (error) {
    res.status(500).json({ error: `Failed to query Gemini API: ${error.message}` });
  }
});

// Route to play music on YouTube - Using ytsr for better video playback
app.post('/api/play-music', async (req, res) => {
  const { song } = req.body;
  try {
    // Search YouTube using ytsr
    const searchResults = await ytsr(song, { limit: 1 });
    if (!searchResults.items[0] || searchResults.items[0].type !== 'video') {
      throw new Error('No video found');
    }
    const video = searchResults.items[0];
    const youtubeUrl = video.url; // Direct video URL
    const videoTitle = video.title;

    let command;
    if (process.platform === 'darwin') {
      command = `open "${youtubeUrl}"`;
    } else if (process.platform === 'win32') {
      command = `start "${youtubeUrl}"`;
    } else if (process.platform === 'linux') {
      command = `xdg-open "${youtubeUrl}"`;
    } else {
      return res.status(400).json({ error: 'Unsupported OS' });
    }

    exec(command, { env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' } }, (error) => {
      if (error) {
        return res.status(500).json({ error: `Failed to open YouTube for ${song}: ${error.message}` });
      }
      res.json({ message: `Playing ${videoTitle}`, url: youtubeUrl });
    });
  } catch (error) {
    // Fallback to search URL if ytsr fails
    const youtubeUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(song)}`;
    let command = process.platform === 'linux' ? `xdg-open "${youtubeUrl}"` : `open "${youtubeUrl}"`;
    exec(command, { env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' } }, (error) => {
      if (error) {
        return res.status(500).json({ error: `Failed to open YouTube for ${song}: ${error.message}` });
      }
      res.json({ message: `Searching for ${song} on YouTube`, url: youtubeUrl });
    });
  }
});

// Route to handle voice commands (temporary text input)
app.post('/api/speak', async (req, res) => {
  const { command } = req.body; // Simulate voice input with text
  
  if (!command) {
    return res.status(400).json({ error: 'No command provided' });
  }

  try {
    // Process command
    let responseMessage;
    const lowerCommand = command.toLowerCase().trim();

    if (lowerCommand.startsWith('open')) {
      const appName = lowerCommand.replace('open', '').trim();
      const response = await axios.post(`http://localhost:${port}/api/open-app`, { appName });
      responseMessage = response.data.message || response.data.error;
    } else if (lowerCommand.includes('news')) {
      const response = await axios.get(`http://localhost:${port}/api/news`);
      responseMessage = response.data.articles.map(a => a.title).join('. ');
    } else if (lowerCommand.startsWith('play')) {
      const song = lowerCommand.replace('play', '').trim();
      const response = await axios.post(`http://localhost:${port}/api/play-music`, { song });
      responseMessage = response.data.message;
    } else {
      const response = await axios.post(`http://localhost:${port}/api/gemini`, { query: command });
      responseMessage = response.data.response;
    }

    // Speak the response
    const speechResult = await speakText(responseMessage);
    res.json({ 
      command, 
      response: responseMessage, 
      speechMethod: speechResult.method 
    });
    
  } catch (error) {
    res.status(500).json({ error: `Command processing failed: ${error.message}` });
  }
});

// Test endpoint for speech
app.post('/api/test-speech', async (req, res) => {
  const { text } = req.body;
  try {
    const result = await speakText(text || 'Hello, this is a test');
    res.json({ success: true, method: result.method });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log('Testing speech on startup...');
  speakText('Server started successfully').catch(console.error);
});