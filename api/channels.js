const express = require("express");
const router = express.Router();
const pusher = require('../pusher');
const supabase = require('../supabase');


module.exports = function () {
    router.get('/', async (req, res) => {
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

      router.post('/', async (req, res) => {
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

  return router;
};
