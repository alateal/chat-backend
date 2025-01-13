const express = require("express");
const router = express.Router();
const { clerkClient } = require("@clerk/express");
const pusher = require('../pusher');
const supabase = require('../supabase');


module.exports = function () {
  router.get("/", async (req, res) => {
    try {
      const users = await clerkClient.users.getUserList();

      res.json({ users });
    } catch (error) {
      console.error("Error:", error);
      res.status(500).json({ error: "Error fetching users from Clerk" });
    }
  });

  // Get all users with their online status
  router.get("/status", async (req, res) => {
    try {
      const { data: statuses, error } = await supabase
        .from("user_status")
        .select("user_id, is_online")
        .order("user_id");

      if (error) throw error;

      // Create a map of user statuses
      const userStatuses = statuses.reduce((acc, status) => {
        acc[status.user_id] = status.is_online;
        return acc;
      }, {});

      res.json({ userStatuses });
    } catch (error) {
      console.error("Error fetching user statuses:", error);
      res.status(500).json({ error: "Error fetching user statuses" });
    }
  });

  // Update user online status
  router.post("/status", async (req, res) => {
    try {
      const { userId } = req.auth;
      const { isOnline } = req.body;

      // First check if user exists in user_status
      const { data: existingStatus } = await supabase
        .from("user_status")
        .select()
        .eq("user_id", userId)
        .single();

      if (!existingStatus) {
        // Create a new status entry
        await supabase
          .from("user_status")
          .insert([{ user_id: userId, is_online: isOnline }]);
      } else {
        // Update existing status
        await supabase
          .from("user_status")
          .update({ is_online: isOnline })
          .eq("user_id", userId);
      }

      // Get user details for the status update event
      const user = await clerkClient.users.getUser(userId);
      const statusUpdate = {
        userId,
        isOnline,
        username: user.username,
        imageUrl: user.imageUrl,
      };

      res.json(statusUpdate);
    } catch (error) {
      console.error("Error updating status:", error);
      res.status(500).json({ error: "Error updating status" });
    }
  });

  return router;
};
