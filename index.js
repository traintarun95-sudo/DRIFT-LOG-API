import { createClient } from '@supabase/supabase-js'

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
)

// Claude API helper
async function callClaude(prompt, systemPrompt = '') {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-3-sonnet-20240229',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }]
    })
  })
  
  const data = await response.json()
  return data.content[0].text.trim()
}

// Normalize identity
async function normalizeIdentity(text) {
  const systemPrompt = "You are a deterministic text normalization engine. Convert input to normalized identity key. Rules: lowercase, remove articles (a/an/the), lemmatize verbs, extract core: action_target_context (snake_case). Return ONLY identity string."
  return await callClaude(`Normalize: ${text}`, systemPrompt)
}

// Assign category  
async function assignCategory(text) {
  const systemPrompt = "Assign category from: Relationships, Work, Finance, Health, Self. Choose most direct life domain. If uncertain → Self. Return only category string."
  return await callClaude(`Categorize: ${text}`, systemPrompt)
}

// API Routes
export default async function handler(req, res) {
  const { method, url } = req
  
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  
  if (method === 'OPTIONS') {
    return res.status(200).end()
  }

  try {
    // Parse URL path
    const path = new URL(url, `http://${req.headers.host}`).pathname

    if (path === '/drift/create' && method === 'POST') {
      const { text, user_id } = req.body
      
      // Normalize identity
      const identity = await normalizeIdentity(text)
      
      // Check existing
      const { data: existing } = await supabase
        .from('drift_entries')
        .select('*')
        .eq('user_id', user_id)
        .eq('identity', identity)
        .single()
      
      if (existing) {
        // Increment repetition
        const { data } = await supabase
          .from('drift_entries')
          .update({
            repetition_count: existing.repetition_count + 1,
            last_interaction_at: new Date().toISOString()
          })
          .eq('id', existing.id)
          .select()
          .single()
        
        return res.json(data)
      } else {
        // Create new
        const category = await assignCategory(text)
        
        const { data } = await supabase
          .from('drift_entries')
          .insert({
            user_id,
            text,
            identity,
            category
          })
          .select()
          .single()
        
        return res.json(data)
      }
    }

    if (path === '/drift/update-status' && method === 'POST') {
      const { drift_id, action, user_id } = req.body
      
      if (action === 'doing') {
        const { data } = await supabase
          .from('drift_entries')
          .update({
            status: 'doing',
            last_interaction_at: new Date().toISOString()
          })
          .eq('id', drift_id)
          .eq('user_id', user_id)
          .select()
          .single()
        
        return res.json(data)
      }
      
      if (action === 'done') {
        // Get drift entry
        const { data: drift } = await supabase
          .from('drift_entries')
          .select('*')
          .eq('id', drift_id)
          .eq('user_id', user_id)
          .single()
        
        // Calculate resolution time
        const resolution_time_seconds = Math.floor(
          (new Date() - new Date(drift.created_at)) / 1000
        )
        
        // Move to swift
        const { data: swift } = await supabase
          .from('swift_entries')
          .insert({
            user_id: drift.user_id,
            drift_id: drift.id,
            text: drift.text,
            identity: drift.identity,
            category: drift.category,
            repetition_count: drift.repetition_count,
            created_at: drift.created_at,
            resolution_time_seconds
          })
          .select()
          .single()
        
        // Remove from drift
        await supabase
          .from('drift_entries')
          .delete()
          .eq('id', drift_id)
        
        return res.json(swift)
      }
    }

    if (path === '/drift' && method === 'GET') {
      const { user_id } = req.query
      
      const { data } = await supabase
        .from('drift_entries')
        .select('*')
        .eq('user_id', user_id)
        .gte('repetition_count', 3)
        .order('created_at', { ascending: false })
      
      return res.json(data)
    }

    if (path === '/swift' && method === 'GET') {
      const { user_id } = req.query
      
      const { data } = await supabase
        .from('swift_entries')
        .select('*')
        .eq('user_id', user_id)
        .order('resolved_at', { ascending: false })
      
      return res.json(data)
    }

    if (path === '/realms' && method === 'GET') {
      const { user_id } = req.query
      
      const { data } = await supabase
        .from('realm_snapshots')
        .select('*')
        .eq('user_id', user_id)
        .order('computed_at', { ascending: false })
        .limit(5)
      
      return res.json(data)
    }

    return res.status(404).json({ error: 'Not found' })

  } catch (error) {
    console.error(error)
    return res.status(500).json({ error: error.message })
  }
}
