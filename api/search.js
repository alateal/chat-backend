const express = require("express");
const router = express.Router();
const { clerkClient } = require("@clerk/express");
const supabase = require("../supabase");

module.exports = function () {
  router.get("/", async (req, res) => {
    try {
      const { query } = req.query;

      if (!query || query.length < 1) {
        return res.json({ messages: [], users: [], files: [], channels: [] });
      }

      // Search channels
      const { data: channels, error: channelsError } = await supabase
        .from("channels")
        .select("*")
        .ilike("name", `%${query}%`)
        .order("created_at", { ascending: false })
        .limit(10);

      if (channelsError) throw channelsError;

      // Only search users if query is 3+ characters
      let users = [];
      if (query.length >= 3) {
        try {
          const userList = await clerkClient.users.getUserList();
          const allUsers = userList?.data || userList || [];

          users = allUsers
            .filter((user) => {
              const firstName = user.firstName || "";
              const lastName = user.lastName || "";
              const username = user.username || "";

              const searchString =
                `${firstName} ${lastName} ${username}`.toLowerCase();
              const searchQuery = query.toLowerCase();

              return searchString.includes(searchQuery);
            })
            .slice(0, 10);
        } catch (error) {
          console.error("Clerk user search error:", error);
        }
      }

      // Search messages and files
      const { data: messages, error: messagesError } = await supabase
        .from("messages")
        .select("*, channel_id, conversation_id, file_attachments")
        .or(
          `content.ilike.%${query}%, file_attachments->files->>file_name.ilike.%${query}%`
        )
        .order("created_at", { ascending: false })
        .limit(10);

      if (messagesError) throw messagesError;

      // Extract files from messages
      const files = messages
        ?.filter((msg) => msg.file_attachments?.files)
        .flatMap((msg) => msg.file_attachments.files)
        .filter((file) =>
          file.file_name.toLowerCase().includes(query.toLowerCase())
        )
        .slice(0, 10);

      // Get user details for messages
      const messagesWithUsers = await Promise.all(
        messages?.map(async (message) => {
          const user = await clerkClient.users.getUser(message.created_by);
          return {
            ...message,
            user: {
              id: user.id,
              username:
                user.username ||
                `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
                "Unknown User",
              imageUrl: user.imageUrl,
            },
          };
        }) || []
      );

      // Format user results
      const formattedUsers = users.map((user) => ({
        id: user.id,
        username:
          user.username ||
          `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
          "Unknown User",
        imageUrl: user.imageUrl,
        email: user.emailAddresses?.[0]?.emailAddress,
      }));

      // Add creator details to channels
      const channelsWithCreators = await Promise.all(
        channels?.map(async (channel) => {
          const creator = await clerkClient.users.getUser(channel.created_by);
          return {
            ...channel,
            creator: {
              id: creator.id,
              username:
                creator.username ||
                `${creator.firstName || ""} ${creator.lastName || ""}`.trim() ||
                "Unknown User",
              imageUrl: creator.imageUrl,
            },
          };
        }) || []
      );

      res.json({
        messages: messagesWithUsers,
        users: formattedUsers,
        files,
        channels: channelsWithCreators,
      });
    } catch (error) {
      console.error("Search error:", error);
      res.status(500).json({ error: "Search failed" });
    }
  });
  return router;
};
