const express = require("express");
const router = express.Router();
const { clerkClient } = require("@clerk/express");
const supabase = require("../supabase");
const pusher = require("../pusher");

module.exports = function () {
  router.get("/", async (req, res) => {
    try {
      const { data: messages, error } = await supabase
        .from("messages")
        .select("*")
        .order("created_at", { ascending: true });

      if (error) throw error;

      res.json({ messages });
    } catch (error) {
      console.error("Error:", error);
      res.status(500).json({ error: "Error fetching messages" });
    }
  });

  router.post("/", async (req, res) => {
    try {
      const { userId } = req.auth;
      const { content, files, conversation_id, parent_message_id } = req.body;

      if (!content && !files?.length) {
        return res.status(400).json({ error: "Content or files required" });
      }

      if (!conversation_id) {
        return res.status(400).json({ error: "Conversation ID required" });
      }

      const user = await clerkClient.users.getUser(userId);

      const { data: message, error } = await supabase
        .from("messages")
        .insert([
          {
            content,
            conversation_id,
            created_by: userId,
            file_attachments: files?.length ? files : null,
            parent_message_id: parent_message_id || null,
          },
        ])
        .select()
        .single();

      if (error) throw error;

      await pusher.trigger(
        `conversation-${conversation_id}`,
        "new-message",
        message
      );
      res.json(message);
    } catch (error) {
      console.error("Error:", error);
      res.status(500).json({ error: "Error creating message" });
    }
  });

  router.post("/:messageId/reactions", async (req, res) => {
    try {
      const { userId } = req.auth;
      const { messageId } = req.params;
      const { emoji } = req.body;

      // Get message with both channel_id and conversation_id
      const { data: message, error: fetchError } = await supabase
        .from("messages")
        .select("reactions, conversation_id")
        .eq("id", messageId)
        .single();

      if (fetchError) throw fetchError;

      // Update or create the reaction
      let reactions = message.reactions || [];
      const existingReactionIndex = reactions.findIndex(
        (r) => r.emoji === emoji
      );

      if (existingReactionIndex >= 0) {
        if (reactions[existingReactionIndex].users.includes(userId)) {
          reactions[existingReactionIndex].users = reactions[
            existingReactionIndex
          ].users.filter((id) => id !== userId);
          if (reactions[existingReactionIndex].users.length === 0) {
            reactions = reactions.filter(
              (_, index) => index !== existingReactionIndex
            );
          }
        } else {
          reactions[existingReactionIndex].users.push(userId);
        }
      } else {
        reactions.push({
          emoji,
          users: [userId],
        });
      }

      // Update the message
      const { data: updatedMessage, error: updateError } = await supabase
        .from("messages")
        .update({ reactions })
        .eq("id", messageId)
        .select()
        .single();

      if (updateError) throw updateError;


      // Trigger appropriate Pusher event based on message type
      const eventChannel = `conversation-${message.conversation_id}`;

      await pusher.trigger(eventChannel, "message-updated", updatedMessage);

      res.json(updatedMessage);
    } catch (error) {
      console.error("Error updating reaction:", error);
      res.status(500).json({ error: "Error updating reaction" });
    }
  });

  return router;
};
