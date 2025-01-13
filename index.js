const express = require('express')
const dotenv = require('dotenv').config()
const { Webhook } = require('svix')
const { clerkClient, requireAuth } = require('@clerk/express')
const cors = require('cors');
const supabase = require('./supabase');
const pusher = require('./pusher');
const apiRouter = require('./api');

const app = express()
const PORT = process.env.PORT;

// Add logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json');
  next();
});

app.use(cors({
  origin: [process.env.FRONTEND_URL],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.get('/sign-in', (req, res) => {
  // Assuming you have a template engine installed and are using a Clerk JavaScript SDK on this page
  res.redirect('/')
})

app.use('/api', requireAuth({ signInUrl: '/sign-in' }), apiRouter());

app.post('/webhooks/clerk', 
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const webhook = new Webhook(process.env.CLERK_WEBHOOK_SECRET);
      const event = webhook.verify(JSON.stringify(req.body), req.headers);

      // Handle user creation
      if (event.type === 'user.created') {
        const userId = event.data.id;
        
        // Initialize user status
        await supabase
          .from('user_status')
          .insert([{ 
            user_id: userId, 
            is_online: false 
          }]);

        // Get full user details and notify frontend
        const user = await clerkClient.users.getUser(userId);
        const newUser = {
          id: user.id,
          username: user.username || `${user.firstName} ${user.lastName}`.trim() || 'Unknown User',
          imageUrl: user.imageUrl,
          email: user.emailAddresses?.[0]?.emailAddress
        };
        await pusher.trigger('presence', 'user-created', newUser);
        console.log('Initialized status for new user:', userId);
      }

      // Handle session creation (user going online)
      if (event.type === 'session.created') {
        const userId = event.data.user_id;
        
        // Update user status to online
        const { error: updateError } = await supabase
          .from('user_status')
          .update({ is_online: true })
          .eq('user_id', userId);

        if (updateError) throw updateError;

        // Get user details and notify frontend
        const user = await clerkClient.users.getUser(userId);
        const statusUpdate = {
          userId,
          isOnline: true,
          username: user.username || `${user.firstName} ${user.lastName}`.trim() || 'Unknown User',
          imageUrl: user.imageUrl
        };

        await pusher.trigger('presence', 'status-updated', statusUpdate);
      }

      // Handle session end/removal (user going offline)
      if (event.type === 'session.removed' || event.type === 'session.ended') {
        const userId = event.data.user_id;
        
        // Update user status to offline
        const { error: updateError } = await supabase
          .from('user_status')
          .update({ is_online: false })
          .eq('user_id', userId);

        if (updateError) throw updateError;

        // Get user details and notify frontend
        const user = await clerkClient.users.getUser(userId);
        const statusUpdate = {
          userId,
          isOnline: false,
          username: user.username || `${user.firstName} ${user.lastName}`.trim() || 'Unknown User',
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

app.get('/', (req, res) => {
  res.json({ message: "Hello World" });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

process.on('SIGINT', () => { console.log('exiting…'); process.exit(); });

process.on('exit', () => { console.log('exiting…'); process.exit(); });