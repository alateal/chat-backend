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
      const { content, channel_id, files } = req.body;

      if (!content && !files?.length) {
        return res.status(400).json({ error: "Content or files required" });
      }

      if (!channel_id) {
        return res.status(400).json({ error: "Channel ID required" });
      }

      const user = await clerkClient.users.getUser(userId);

      const { data: message, error } = await supabase
        .from("messages")
        .insert([
          {
            content,
            channel_id,
            created_by: userId,
            file_attachments: files?.length ? { files } : null,
          },
        ])
        .select()
        .single();

      if (error) throw error;

      const messageWithUser = {
        ...message,
        user: {
          id: user.id,
          username: user.username,
          imageUrl: user.imageUrl,
        },
      };

      await pusher.trigger(
        `channel-${channel_id}`,
        "new-message",
        messageWithUser
      );
      res.json(messageWithUser);
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
        .select("reactions, channel_id, conversation_id")
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

      // Add user data to the updated message
      const user = await clerkClient.users.getUser(updatedMessage.created_by);
      const messageWithUser = {
        ...updatedMessage,
        user: {
          id: user.id,
          username: `${user.firstName} ${user.lastName}`,
          imageUrl: user.imageUrl,
        },
      };

      // Trigger appropriate Pusher event based on message type
      const eventChannel = message.channel_id
        ? `channel-${message.channel_id}`
        : `conversation-${message.conversation_id}`;

      await pusher.trigger(eventChannel, "message-updated", messageWithUser);

      res.json(messageWithUser);
    } catch (error) {
      console.error("Error updating reaction:", error);
      res.status(500).json({ error: "Error updating reaction" });
    }
  });

  return router;
};
