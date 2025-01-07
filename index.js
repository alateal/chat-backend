require('dotenv').config()
const express = require('express')
const { clerkClient, requireAuth } = require('@clerk/express')
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express()
const PORT = process.env.PORT || 3000;

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Middleware to ensure JSON responses
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json');
  next();
});

app.use(cors({
  origin: 'http://localhost:5173',
  credentials: true
}));

app.get('/protected', requireAuth({ signInUrl: '/sign-in' }), async (req, res) => {
  const { userId } = req.auth
  const user = await clerkClient.users.getUser(userId)
  return res.json({ user })
})

app.get('/sign-in', (req, res) => {
  // Assuming you have a template engine installed and are using a Clerk JavaScript SDK on this page
  res.redirect('/')
})



app.get('/api/channels', requireAuth({ signInUrl: '/sign-in' }), async (req, res) => {
  try {
    const { data: channels, error } = await supabase
      .from('channels')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) throw error;

    res.json({ channels });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error fetching channels' });
  }
});

app.get('/api/messages', requireAuth({ signInUrl: '/sign-in' }), async (req, res) => {
  try {
    const { data: messages, error } = await supabase
      .from('messages')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ messages });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error fetching messages' });
  }
});

app.get('/api/users', requireAuth({ signInUrl: '/sign-in' }), async (req, res) => {
  try {
    const users = await clerkClient.users.getUserList();

    res.json({ users: users.data });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error fetching users from Clerk' });
  }
});

app.post('/api/channels', requireAuth({ signInUrl: '/sign-in' }), async (req, res) => {
  try {
    const { userId } = req.auth;
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Channel name is required' });
    }

    const { data: channel, error } = await supabase
      .from('channels')
      .insert([
        { 
          name,
          created_by: userId,
        }
      ])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(channel);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error creating channel' });
  }
});

app.listen(PORT, () => {
  console.log(`Example app listening at http://localhost:${PORT}`)
})