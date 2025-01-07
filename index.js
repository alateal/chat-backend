require('dotenv').config()
const express = require('express')
const { clerkClient, requireAuth } = require('@clerk/express')

const app = express()
const PORT = process.env.PORT || 3000;

app.get('/protected', requireAuth({ signInUrl: '/sign-in' }), async (req, res) => {
  const { userId } = req.auth
  const user = await clerkClient.users.getUser(userId)
  return res.json({ user })
})

app.get('/sign-in', (req, res) => {
  // Assuming you have a template engine installed and are using a Clerk JavaScript SDK on this page
  res.redirect('/')
})

app.get('/api/channels', (req, res) => {
  res.json({ channels: [{
    id: '1',
    name: 'Channel 1',
    description: 'Channel 1 description',
    createdAt: new Date(),
    updatedAt: new Date(),
  }] })
});

app.listen(PORT, () => {
  console.log(`Example app listening at http://localhost:${PORT}`)
})