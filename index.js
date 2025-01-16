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
  origin: process.env.FRONTEND_URL,
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
    const evt = req.body;
    const { type, data } = evt;

    console.log(`Received Clerk webhook: ${type}`);

    if (type === 'user.created') {
      try {
        // First, find the "general" conversation
        const { data: generalChannel, error: findError } = await supabase
          .from('conversations')
          .select('id')
          .eq('name', 'general')
          .eq('is_channel', true)
          .single();

        if (findError) {
          console.error('Error finding general channel:', findError);
          return res.status(500).json({ error: 'Error finding general channel' });
        }

        if (!generalChannel) {
          console.error('General channel not found');
          return res.status(404).json({ error: 'General channel not found' });
        }

        // Add the new user to the general channel
        const { error: memberError } = await supabase
          .from('conversation_members')
          .insert({
            conversation_id: generalChannel.id,
            user_id: data.id
          });

        if (memberError) {
          console.error('Error adding user to general channel:', memberError);
          return res.status(500).json({ error: 'Error adding user to general channel' });
        }

        console.log(`Added user ${data.id} to general channel`);
      } catch (error) {
        console.error('Error processing user.created webhook:', error);
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
    // Handle other webhook events...
    res.json({ received: true });
});

app.get('/', (req, res) => {
  res.json({ message: "Hello World" });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

process.on('SIGINT', () => { console.log('exiting…'); process.exit(); });

process.on('exit', () => { console.log('exiting…'); process.exit(); });