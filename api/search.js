const express = require("express");
const router = express.Router();
const { clerkClient } = require("@clerk/express");
const supabase = require("../supabase");

module.exports = function () {
  router.get("/", async (req, res) => {
    try {
      const { query } = req.query;
      const { userId } = req.auth;

      if (!query) {
        return res.json({
          messages: [],
          channels: [],
          users: [],
          files: []
        });
      }

      // Search messages (allow any length)
      const { data: messages, error: messagesError } = await supabase
        .from("messages")
        .select(`
          *,
          conversation:conversation_id (
            name,
            is_channel
          )
        `)
        .ilike("content", `%${query}%`)
        .limit(5);

      if (messagesError) throw messagesError;

      // Search conversations/channels (allow any length)
      const { data: channels, error: channelsError } = await supabase
        .from("conversations")
        .select("*")
        .eq("is_channel", true)
        .ilike("name", `%${query}%`)
        .limit(5);

      if (channelsError) throw channelsError;

      // Search users (only if query length >= 3)
      let users = [];
      if (query.length >= 3) {
        try {
          const clerkUsers = await clerkClient.users.getUserList({
            query: query,
            limit: 5
          });
          
          // Ensure we have an array and format the users
          users = Array.isArray(clerkUsers) ? clerkUsers : clerkUsers.data || [];
        } catch (error) {
          console.error('Error fetching users from Clerk:', error);
          users = []; // Fallback to empty array on error
        }
      }

      // Format response
      const formattedMessages = await Promise.all(messages.map(async message => {
        const user = await clerkClient.users.getUser(message.created_by);
        return {
          id: message.id,
          content: message.content,
          created_at: message.created_at,
          conversation_id: message.conversation_id,
          user: {
            id: user.id,
            username: user.username || `${user.firstName} ${user.lastName}`.trim() || 'Unknown User',
            imageUrl: user.imageUrl
          }
        };
      }));

      const formattedChannels = channels.map(channel => ({
        id: channel.id,
        name: channel.name,
        created_at: channel.created_at,
        creator: {
          id: channel.created_by,
          username: 'Unknown User',
          imageUrl: ''
        }
      }));

      const formattedUsers = (Array.isArray(users) ? users : []).map(user => ({
        id: user.id,
        username: user.username || `${user.firstName} ${user.lastName}`.trim() || 'Unknown User',
        imageUrl: user.imageUrl
      }));

      res.json({
        messages: formattedMessages,
        channels: formattedChannels,
        users: formattedUsers,
        files: [] // Add file search later if needed
      });

    } catch (error) {
      console.error('Search error:', error);
      res.status(500).json({ error: 'Error performing search' });
    }
  });

  return router;
};
