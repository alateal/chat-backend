const express = require('express');
const { clerkClient } = require('@clerk/clerk-sdk-node');
const supabase = require('../supabase');
const pusher = require('../pusher');

// Change to a function that returns the router
module.exports = function() {
  const router = express.Router();

  // Get thread replies
  router.get('/:messageId/replies', async (req, res) => {
    try {
      const { messageId } = req.params;
      const { userId } = req.auth;

      // Get all replies for this thread
      const { data: replies, error } = await supabase
        .from('messages')
        .select('*')
        .eq('parent_message_id', messageId)
        .order('created_at', { ascending: true });

      if (error) throw error;

      // Get user details for each reply
      const repliesWithUsers = await Promise.all(
        replies.map(async (reply) => {
          const user = await clerkClient.users.getUser(reply.created_by);
          return {
            ...reply,
            user: {
              id: user.id,
              username: user.username || `${user.firstName} ${user.lastName}`.trim() || 'Unknown User',
              imageUrl: user.imageUrl
            }
          };
        })
      );

      res.json({ replies: repliesWithUsers });
    } catch (error) {
      console.error('Error fetching thread replies:', error);
      res.status(500).json({ error: 'Failed to fetch replies' });
    }
  });

  // Add reply to thread
  router.post('/:messageId/replies', async (req, res) => {
    try {
      const { messageId } = req.params;
      const { content, files } = req.body;
      const { userId } = req.auth;

      // Get parent message to copy channel_id and conversation_id
      const { data: parentMessage, error: parentError } = await supabase
        .from('messages')
        .select('channel_id, conversation_id')
        .eq('id', messageId)
        .single();

      if (parentError) throw parentError;

      // Insert the reply
      const { data: reply, error } = await supabase
        .from('messages')
        .insert([{
          content,
          created_by: userId,
          parent_message_id: messageId,
          channel_id: parentMessage.channel_id,
          conversation_id: parentMessage.conversation_id,
          file_attachments: files ? { files } : null
        }])
        .select()
        .single();

      if (error) throw error;

      // Get user details for the reply
      const user = await clerkClient.users.getUser(userId);
      const replyWithUser = {
        ...reply,
        user: {
          id: user.id,
          username: user.username || `${user.firstName} ${user.lastName}`.trim() || 'Unknown User',
          imageUrl: user.imageUrl
        }
      };

      // Trigger Pusher event for real-time updates
      await pusher.trigger(`thread-${messageId}`, 'new-reply', replyWithUser);

      res.json(replyWithUser);
    } catch (error) {
      console.error('Error adding thread reply:', error);
      res.status(500).json({ error: 'Failed to add reply' });
    }
  });

  // Add thread summary endpoint
  router.get('/:messageId/summary', async (req, res) => {
    try {
      const { messageId } = req.params;

      // Get all replies for this thread
      const { data: replies, error } = await supabase
        .from('messages')
        .select('*')
        .eq('parent_message_id', messageId)
        .order('created_at', { ascending: false });

      if (error) throw error;

      if (!replies.length) {
        return res.json({
          replyCount: 0,
          lastReplyTime: null,
          recentRepliers: []
        });
      }

      // Get unique repliers (most recent first)
      const uniqueReplierIds = [...new Set(replies.map(reply => reply.created_by))];
      const recentRepliers = await Promise.all(
        uniqueReplierIds.slice(0, 3).map(async (userId) => {
          const user = await clerkClient.users.getUser(userId);
          return {
            id: user.id,
            username: user.username || `${user.firstName} ${user.lastName}`.trim() || 'Unknown User',
            imageUrl: user.imageUrl
          };
        })
      );

      res.json({
        replyCount: replies.length,
        lastReplyTime: replies[0].created_at,
        recentRepliers
      });
    } catch (error) {
      console.error('Error fetching thread summary:', error);
      res.status(500).json({ error: 'Failed to fetch thread summary' });
    }
  });

  return router;
}; 