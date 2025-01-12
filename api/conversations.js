const express = require("express");
const router = express.Router();
const { clerkClient } = require("@clerk/express");
const supabase = require("../supabase");

module.exports = function () {
  router.get("/:conversationId/messages", async (req, res) => {
    try {
      const { conversationId } = req.params;
      const { userId } = req.auth;
      const { page = 0, limit = 50 } = req.query;

      // Verify user is part of conversation
      const { data: member, error: memberError } = await supabase
        .from("conversation_members")
        .select()
        .eq("conversation_id", conversationId)
        .eq("user_id", userId)
        .single();

      if (memberError || !member) {
        return res
          .status(403)
          .json({ error: "Not authorized to view this conversation" });
      }

      // Fetch messages with pagination
      const {
        data: messages,
        error,
        count,
      } = await supabase
        .from("messages")
        .select("*", { count: "exact" })
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true })
        .range(page * limit, (page + 1) * limit - 1);

      if (error) throw error;

      // Add user data to messages
      const messagesWithUsers = await Promise.all(
        messages.map(async (message) => {
          const user = await clerkClient.users.getUser(message.created_by);
          return {
            ...message,
            user: {
              id: user.id,
              username: `${user.firstName} ${user.lastName}`,
              imageUrl: user.imageUrl,
            },
          };
        })
      );

      res.json({
        messages: messagesWithUsers.reverse(),
        total: count,
        hasMore: count > (page + 1) * limit,
      });
    } catch (error) {
      console.error("Error:", error);
      res.status(500).json({ error: "Error fetching messages" });
    }
  });


// Send message in conversation
router.post('/:conversationId/messages', async (req, res) => {
    try {
      const { conversationId } = req.params;
      const { userId } = req.auth;
      const { content, files } = req.body;
  
      const user = await clerkClient.users.getUser(userId);
  
      // Create message with file attachments
      const { data: message, error } = await supabase
        .from('messages')
        .insert([{
          content,
          conversation_id: conversationId,
          created_by: userId,
          file_attachments: files ? { files } : null,
        }])
        .select()
        .single();
  
      if (error) throw error;
  
      const messageWithUser = {
        ...message,
        user: {
          id: user.id,
          username: user.username,
          imageUrl: user.imageUrl
        }
      };
  
      res.json(messageWithUser);
    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({ error: 'Error sending message' });
    }
  });

  // Get or create conversation between two users
  router.post('/', async (req, res) => {
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
  
  return router;
};
