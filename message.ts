router.post('/api/messages', async (req, res) => {
    try {
      const { content, channelId, userId } = req.body;
      
      // Save message to database
      const message = await prisma.message.create({
        data: {
          content,
          channelId,
          userId,
        },
        include: {
          user: true, // Include user details
        },
      });
  
      // Trigger Pusher event
      await pusher.trigger(`channel-${channelId}`, 'new-message', message);
  
      res.json({ message });
    } catch (error) {
      console.error('Error sending message:', error);
      res.status(500).json({ error: 'Failed to send message' });
    }
  });