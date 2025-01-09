require('dotenv').config()
const express = require('express')
const { clerkClient, requireAuth, Webhook } = require('@clerk/express')
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
  origin: ['http://localhost:5173', 'https://your-ngrok-url.ngrok.io'],
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
    console.log('Triggered channel message:', {
      channel: `channel-${channel_id}`,
      message: messageWithUser
    });

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

    // Get message with both channel_id and conversation_id
    const { data: message, error: fetchError } = await supabase
      .from('messages')
      .select('reactions, channel_id, conversation_id')
      .eq('id', messageId)
      .single();

    if (fetchError) throw fetchError;

    // Update or create the reaction
    let reactions = message.reactions || [];
    const existingReactionIndex = reactions.findIndex(r => r.emoji === emoji);
    
    if (existingReactionIndex >= 0) {
      if (reactions[existingReactionIndex].users.includes(userId)) {
        reactions[existingReactionIndex].users = reactions[existingReactionIndex].users
          .filter(id => id !== userId);
        if (reactions[existingReactionIndex].users.length === 0) {
          reactions = reactions.filter((_, index) => index !== existingReactionIndex);
        }
      } else {
        reactions[existingReactionIndex].users.push(userId);
      }
    } else {
      reactions.push({
        emoji,
        users: [userId]
      });
    }

    // Update the message
    const { data: updatedMessage, error: updateError } = await supabase
      .from('messages')
      .update({ reactions })
      .eq('id', messageId)
      .select()
      .single();

    if (updateError) throw updateError;

    // Add user data to the updated message
    const user = await clerkClient.users.getUser(updatedMessage.created_by);
    const messageWithUser = {
      ...updatedMessage,
      user: {
        id: user.id,
        username: `${user.firstName} ${user.lastName}`,
        imageUrl: user.imageUrl
      }
    };

    // Trigger appropriate Pusher event based on message type
    const eventChannel = message.channel_id 
      ? `channel-${message.channel_id}`
      : `conversation-${message.conversation_id}`;

    await pusher.trigger(eventChannel, 'message-updated', messageWithUser);
    console.log('Triggered reaction update:', {
      channel: eventChannel,
      message: messageWithUser
    });

    res.json(messageWithUser);
  } catch (error) {
    console.error('Error updating reaction:', error);
    res.status(500).json({ error: 'Error updating reaction' });
  }
});

// Get or create conversation between two users
app.post('/api/conversations', requireAuth({ signInUrl: '/sign-in' }), async (req, res) => {
  try {
    const { userId } = req.auth;
    const { otherUserId } = req.body;

    // First try to find existing conversation
    const { data: existingMembers, error: findError } = await supabase
      .from('conversation_members')
      .select('conversation_id')
      .in('user_id', [userId, otherUserId]);

    if (findError) throw findError;

    // Group by conversation_id and find one with both users
    const conversationCounts = existingMembers.reduce((acc, member) => {
      acc[member.conversation_id] = (acc[member.conversation_id] || 0) + 1;
      return acc;
    }, {});

    const existingConversationId = Object.entries(conversationCounts)
      .find(([_, count]) => count === 2)?.[0];

    if (existingConversationId) {
      return res.json({ conversation: { id: existingConversationId } });
    }

    // Create new conversation if none exists
    const { data: conversation, error: createError } = await supabase
      .from('conversations')
      .insert([{}])
      .select()
      .single();

    if (createError) throw createError;

    // Add both users to conversation, ignore conflicts
    const { error: membersError } = await supabase
      .from('conversation_members')
      .upsert([
        { user_id: userId, conversation_id: conversation.id },
        { user_id: otherUserId, conversation_id: conversation.id }
      ], {
        onConflict: 'user_id,conversation_id',
        ignoreDuplicates: true
      });

    if (membersError) throw membersError;

    res.json({ conversation });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error creating conversation' });
  }
});

// Get messages for a conversation with pagination
app.get('/api/conversations/:conversationId/messages', requireAuth({ signInUrl: '/sign-in' }), async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { userId } = req.auth;
    const { page = 0, limit = 50 } = req.query;

    // Verify user is part of conversation
    const { data: member, error: memberError } = await supabase
      .from('conversation_members')
      .select()
      .eq('conversation_id', conversationId)
      .eq('user_id', userId)
      .single();

    if (memberError || !member) {
      return res.status(403).json({ error: 'Not authorized to view this conversation' });
    }

    // Fetch messages with pagination
    const { data: messages, error, count } = await supabase
      .from('messages')
      .select('*', { count: 'exact' })
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .range(page * limit, (page + 1) * limit - 1);

    if (error) throw error;

    // Add user data to messages
    const messagesWithUsers = await Promise.all(messages.map(async (message) => {
      const user = await clerkClient.users.getUser(message.created_by);
      return {
        ...message,
        user: {
          id: user.id,
          username: `${user.firstName} ${user.lastName}`,
          imageUrl: user.imageUrl
        }
      };
    }));

    res.json({ 
      messages: messagesWithUsers.reverse(), 
      total: count,
      hasMore: count > (page + 1) * limit
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error fetching messages' });
  }
});

// Send message in conversation
app.post('/api/conversations/:conversationId/messages', requireAuth({ signInUrl: '/sign-in' }), async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { userId } = req.auth;
    const { content } = req.body;

    const user = await clerkClient.users.getUser(userId);

    const { data: message, error } = await supabase
      .from('messages')
      .insert([{
        content,
        conversation_id: conversationId,
        created_by: userId,
      }])
      .select()
      .single();

    if (error) throw error;

    const messageWithUser = {
      ...message,
      user: {
        id: user.id,
        username: `${user.firstName} ${user.lastName}`,
        imageUrl: user.imageUrl
      }
    };

    await pusher.trigger(`conversation-${conversationId}`, 'new-message', messageWithUser);
    console.log('Triggered direct message:', {
      channel: `conversation-${conversationId}`,
      message: messageWithUser
    });

    res.json(messageWithUser);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error sending message' });
  }
});

// Update user online status
app.post('/api/users/status', requireAuth({ signInUrl: '/sign-in' }), async (req, res) => {
  try {
    const { userId } = req.auth;
    const { isOnline } = req.body;

    // First check if user exists in user_status
    const { data: existingStatus } = await supabase
      .from('user_status')
      .select()
      .eq('user_id', userId)
      .single();

    if (!existingStatus) {
      // Create a new status entry
      await supabase
        .from('user_status')
        .insert([{ user_id: userId, is_online: isOnline }]);
    } else {
      // Update existing status
      await supabase
        .from('user_status')
        .update({ is_online: isOnline })
        .eq('user_id', userId);
    }

    // Get user details for the status update event
    const user = await clerkClient.users.getUser(userId);
    const statusUpdate = {
      userId,
      isOnline,
      username: user.username,
      imageUrl: user.imageUrl
    };

    // Trigger Pusher event for status update
    await pusher.trigger('presence', 'status-updated', statusUpdate);

    res.json(statusUpdate);
  } catch (error) {
    console.error('Error updating status:', error);
    res.status(500).json({ error: 'Error updating status' });
  }
});

// Get all users with their online status
app.get('/api/users/status', requireAuth({ signInUrl: '/sign-in' }), async (req, res) => {
  try {
    const { data: statuses, error } = await supabase
      .from('user_status')
      .select('user_id, is_online')
      .order('user_id');

    if (error) throw error;

    // Create a map of user statuses
    const userStatuses = statuses.reduce((acc, status) => {
      acc[status.user_id] = status.is_online;
      return acc;
    }, {});

    res.json({ userStatuses });
  } catch (error) {
    console.error('Error fetching user statuses:', error);
    res.status(500).json({ error: 'Error fetching user statuses' });
  }
});

app.post('/api/webhooks/clerk', 
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      // Verify the webhook
      const webhook = new Webhook(process.env.CLERK_WEBHOOK_SECRET);
      const event = webhook.verify(JSON.stringify(req.body), req.headers);

      if (event.type === 'session.created') {
        const userId = event.data.user_id;
        
        // Update user status to online
        await supabase
          .from('user_status')
          .upsert({ user_id: userId, is_online: true }, { onConflict: 'user_id' });

        // Get user details for the status update event
        const user = await clerkClient.users.getUser(userId);
        const statusUpdate = {
          userId,
          isOnline: true,
          username: user.username,
          imageUrl: user.imageUrl
        };

        await pusher.trigger('presence', 'status-updated', statusUpdate);
      }

      if (event.type === 'session.ended') {
        const userId = event.data.user_id;
        
        await supabase
          .from('user_status')
          .upsert({ user_id: userId, is_online: false }, { onConflict: 'user_id' });

        const user = await clerkClient.users.getUser(userId);
        const statusUpdate = {
          userId,
          isOnline: false,
          username: user.username,
          imageUrl: user.imageUrl
        };

        await pusher.trigger('presence', 'status-updated', statusUpdate);
      }

      res.json({ received: true });
    } catch (error) {
      console.error('Webhook error:', error);
      res.status(400).json({ error: 'Webhook error' });
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