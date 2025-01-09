require('dotenv').config()
const express = require('express')
const { clerkClient, requireAuth } = require('@clerk/express')
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Pusher = require('pusher');

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
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
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

    res.json({ users });
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

    // Trigger Pusher event for new channel
    await pusher.trigger('channels', 'new-channel', channel);

    res.status(201).json(channel);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error creating channel' });
  }
});

app.post('/api/messages', requireAuth({ signInUrl: '/sign-in' }), async (req, res) => {
  try {
    const { userId } = req.auth;
    const { content, channel_id } = req.body;

    if (!content || !channel_id) {
      return res.status(400).json({ error: 'Content and channel_id are required' });
    }

    const user = await clerkClient.users.getUser(userId);
    
    const { data: message, error } = await supabase
      .from('messages')
      .insert([{ 
        content,
        channel_id,
        created_by: userId,
      }])
      .select()
      .single();

    if (error) throw error;

    // Add user data to the message before sending through Pusher
    const messageWithUser = {
      ...message,
      user: {
        id: user.id,
        username: `${user.firstName} ${user.lastName}`,
        imageUrl: user.imageUrl
      }
    };

    // Trigger Pusher event with the enhanced message
    await pusher.trigger(`channel-${channel_id}`, 'new-message', messageWithUser);

    res.status(201).json(messageWithUser);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error creating message' });
  }
});

app.post('/api/messages/:messageId/reactions', requireAuth({ signInUrl: '/sign-in' }), async (req, res) => {
  try {
    const { userId } = req.auth;
    const { messageId } = req.params;
    const { emoji } = req.body;

    // First get the current message
    const { data: message, error: fetchError } = await supabase
      .from('messages')
      .select('reactions, channel_id')
      .eq('id', messageId)
      .single();

    if (fetchError) throw fetchError;

    // Update or create the reaction
    let reactions = message.reactions || [];
    const existingReactionIndex = reactions.findIndex(r => r.emoji === emoji);
    
    if (existingReactionIndex >= 0) {
      // If user already reacted, remove their reaction
      if (reactions[existingReactionIndex].users.includes(userId)) {
        reactions[existingReactionIndex].users = reactions[existingReactionIndex].users
          .filter(id => id !== userId);
        
        // Remove the reaction entirely if no users left
        if (reactions[existingReactionIndex].users.length === 0) {
          reactions = reactions.filter((_, index) => index !== existingReactionIndex);
        }
      } else {
        // Add user to existing reaction
        reactions[existingReactionIndex].users.push(userId);
      }
    } else {
      // Create new reaction
      reactions.push({
        emoji,
        users: [userId]
      });
    }

    // Update the message with new reactions
    const { data: updatedMessage, error: updateError } = await supabase
      .from('messages')
      .update({ reactions })
      .eq('id', messageId)
      .select()
      .single();

    if (updateError) throw updateError;

    // Trigger Pusher event for the reaction update
    await pusher.trigger(`channel-${message.channel_id}`, 'message-updated', updatedMessage);

    res.json(updatedMessage);
  } catch (error) {
    console.error('Error updating reaction:', error);
    res.status(500).json({ error: 'Error updating reaction' });
  }
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something broke!' });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

// Initialize Pusher with your credentials
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true
});

console.log('Server config:', {
  port: PORT,
  hasClerkKeys: !!process.env.CLERK_SECRET_KEY,
  hasSupabaseKeys: !!process.env.SUPABASE_KEY,
  hasPusherKeys: !!process.env.PUSHER_KEY
});