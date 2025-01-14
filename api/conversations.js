const express = require("express");
const router = express.Router();
const { clerkClient } = require("@clerk/express");
const supabase = require("../supabase");
const pusher = require("../pusher");

module.exports = function () {
  router.get("/:conversationId/messages", async (req, res) => {
    try {
      const { conversationId } = req.params;
      const { userId } = req.auth;

      // Get conversation with members
      const { data: conversation, error: convError } = await supabase
        .from("conversations")
        .select(`
          *,
          conversation_members!inner (
            user_id
          )
        `)
        .eq("id", conversationId)
        .single();

      if (convError) throw convError;

      // Format conversation members
      const conversation_members = conversation.conversation_members.map(m => m.user_id);

      // Verify user is part of conversation
      if (!conversation_members.includes(userId)) {
        return res.status(403).json({ error: "Not authorized to view this conversation" });
      }

      // Fetch messages
      const { data: messages, error } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });

      if (error) throw error;

      res.json(messages);
    } catch (error) {
      console.error("Error:", error);
      res.status(500).json({ error: "Error fetching messages" });
    }
  });

  // Create new conversation or get existing one
  router.post("/", async (req, res) => {
    try {
      const { userId } = req.auth;
      const { isChannel, name, members } = req.body;

      if (!Array.isArray(members) || members.length === 0) {
        return res.status(400).json({ error: "Members array is required and must not be empty" });
      }

      // Include the creator in members if not already present
      if (!members.includes(userId)) {
        members.push(userId);
      }

      if (!isChannel) {
        // For DMs, try to find existing conversation
        const { data: existingMembers, error: findError } = await supabase
          .from("conversation_members")
          .select("conversation_id")
          .in("user_id", members);

        if (findError) throw findError;

        // Group by conversation_id and find one with all members
        const conversationCounts = existingMembers.reduce((acc, member) => {
          acc[member.conversation_id] = (acc[member.conversation_id] || 0) + 1;
          return acc;
        }, {});

        const existingConversationId = Object.entries(conversationCounts)
          .find(([_, count]) => count === members.length)?.[0];

        if (existingConversationId) {
          // Return existing conversation with members
          const { data: existingConversation } = await supabase
            .from("conversations")
            .select("*")
            .eq("id", existingConversationId)
            .single();

          return res.json({ 
            conversation: {
              ...existingConversation,
              conversation_members: members
            }
          });
        }
      }

      // Create new conversation
      const { data: conversation, error: createError } = await supabase
        .from("conversations")
        .insert([{
          name: name || null,
          is_channel: isChannel,
          created_by: userId
        }])
        .select()
        .single();

      if (createError) throw createError;

      // Add all members to conversation
      const memberInserts = members.map(memberId => ({
        user_id: memberId,
        conversation_id: conversation.id
      }));

      const { error: membersError } = await supabase
        .from("conversation_members")
        .upsert(memberInserts, {
          onConflict: "user_id,conversation_id",
          ignoreDuplicates: false
        });

      if (membersError) throw membersError;

      // Return new conversation with members
      res.json({ 
        conversation: {
          ...conversation,
          conversation_members: members
        }
      });

    } catch (error) {
      console.error("Error:", error);
      res.status(500).json({ error: "Error creating conversation" });
    }
  });

  router.get("/me", async (req, res) => {
    try {
      const { userId } = req.auth;

      // Get all conversations where user is a member
      const { data: memberOf, error: memberError } = await supabase
        .from("conversation_members")
        .select(
          `
          conversation_id,
          conversations:conversation_id (
            *
          )
        `
        )
        .eq("user_id", userId);

      if (memberError) throw memberError;

      // Get all members for these conversations
      const conversationIds = memberOf.map((m) => m.conversation_id);
      const { data: allMembers, error: membersError } = await supabase
        .from("conversation_members")
        .select("user_id, conversation_id")
        .in("conversation_id", conversationIds);

      if (membersError) throw membersError;

      // Group members by conversation
      const membersByConversation = allMembers.reduce((acc, member) => {
        if (!acc[member.conversation_id]) {
          acc[member.conversation_id] = [];
        }
        acc[member.conversation_id].push(member.user_id);
        return acc;
      }, {});

      // Format response
      const conversations = memberOf.map((m) => ({
        ...m.conversations,
        conversation_members: membersByConversation[m.conversation_id] || [],
      }));

      res.json({ conversations });
    } catch (error) {
      console.error("Error fetching conversations:", error);
      res.status(500).json({ error: "Failed to fetch conversations" });
    }
  });

  return router;
};
