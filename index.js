const { createClient } = require('@supabase/supabase-js')
const http = require('http')
const url = require('url')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
)

async function callClaude(prompt, systemPrompt = '') {
  try {
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
  } catch (error) {
    console.error('Claude API error:', error)
    throw error
  }
}

function normalizeDeterministically(text) {
  return text
    .toLowerCase()
    .replace(/\b(a|an|the)\b/g, '')
    .replace(/ing\b/g, '')
    .replace(/ed\b/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .substring(0, 50)
}

async function analyzeAvoidancePatterns(text) {
  const systemPrompt = `Extract specific avoidance behaviors from this text and return as JSON array.

Each candidate should have:
- heading: Clear, actionable description (e.g., "Call mom about vacation plans")
- category: One of: Relationships, Work, Finance, Health, Self

Return only valid JSON: [{"heading": "...", "category": "..."}]

Maximum 3 candidates. Focus on specific, actionable items being avoided.`

  try {
    const result = await callClaude(`Extract avoidance patterns from: "${text}"`, systemPrompt)
    let candidates = JSON.parse(result)
    
    candidates = candidates.filter(candidate => 
      candidate.heading && candidate.category
    ).slice(0, 3)
    
    const validCategories = ['Relationships', 'Work', 'Finance', 'Health', 'Self']
    candidates = candidates.map(candidate => ({
      ...candidate,
      category: validCategories.includes(candidate.category) ? candidate.category : 'Self'
    }))
    
    return candidates
  } catch (error) {
    console.error('Pattern analysis error:', error)
    return [{
      heading: text.trim(),
      category: 'Self'
    }]
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }

  const parsedUrl = url.parse(req.url, true)

  if (parsedUrl.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ message: 'Drift Log API - Behavioral Mirror', status: 'online' }))
    return
  }

  if (parsedUrl.pathname === '/drift/analyze' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => body += chunk.toString())
    req.on('end', async () => {
      try {
        const { text, user_id } = JSON.parse(body)
        
        if (!text || !user_id) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing text or user_id' }))
          return
        }

        const candidates = await analyzeAvoidancePatterns(text)
        
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ candidates }))
      } catch (error) {
        console.error('Analyze error:', error)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: error.message }))
      }
    })
    return
  }

  if (parsedUrl.pathname === '/drift/confirm' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => body += chunk.toString())
    req.on('end', async () => {
      try {
        const { candidates, user_id } = JSON.parse(body)
        
        if (!candidates || !Array.isArray(candidates) || !user_id) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing candidates array or user_id' }))
          return
        }

        const results = []

        for (const candidate of candidates) {
          const { heading, category } = candidate
          const identity = normalizeDeterministically(heading)
          
          const { data: existing, error: selectError } = await supabase
            .from('drift_entries')
            .select('*')
            .eq('user_id', user_id)
            .eq('identity', identity)
            .maybeSingle()
          
          if (selectError) {
            console.error('Database select error:', selectError)
          }

          if (existing) {
            const newCount = existing.repetition_count + 1
            
            const { data: updated, error: updateError } = await supabase
              .from('drift_entries')
              .update({
                repetition_count: newCount,
                last_interaction_at: new Date().toISOString(),
                text: heading
              })
              .eq('id', existing.id)
              .select()
              .single()
            
            if (updateError) {
              throw updateError
            }
            
            results.push({
              ...updated,
              is_new: false,
              shows_in_drift: updated.repetition_count >= 3
            })
          } else {
            const { data: created, error: insertError } = await supabase
              .from('drift_entries')
              .insert({
                user_id,
                text: heading,
                identity,
                category,
                repetition_count: 1,
                status: 'active',
                active_time_accumulated_seconds: 0
              })
              .select()
              .single()
            
            if (insertError) {
              throw insertError
            }
            
            results.push({
              ...created,
              is_new: true,
              shows_in_drift: false
            })
          }
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ results }))
      } catch (error) {
        console.error('Confirm candidates error:', error)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: error.message }))
      }
    })
    return
  }

  if (parsedUrl.pathname === '/drift' && req.method === 'GET') {
    try {
      const { user_id } = parsedUrl.query
      
      if (!user_id) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing user_id parameter' }))
        return
      }

      const { data, error } = await supabase
        .from('drift_entries')
        .select('*')
        .eq('user_id', user_id)
        .gte('repetition_count', 3)
        .order('last_interaction_at', { ascending: false })
      
      if (error) {
        throw error
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data || []))
    } catch (error) {
      console.error('Get drift error:', error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: error.message }))
    }
    return
  }

  if (parsedUrl.pathname === '/drift/update-status' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => body += chunk.toString())
    req.on('end', async () => {
      try {
        const { drift_id, action, user_id, reflection } = JSON.parse(body)
        
        if (!drift_id || !action || !user_id) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing drift_id, action, or user_id' }))
          return
        }

        if (action === 'doing') {
          const { data: currentEntry, error: selectError } = await supabase
            .from('drift_entries')
            .select('*')
            .eq('id', drift_id)
            .eq('user_id', user_id)
            .single()
          
          if (selectError) {
            throw selectError
          }

          let accumulated = currentEntry.active_time_accumulated_seconds || 0
          if (currentEntry.doing_started_at) {
            accumulated += Math.floor((new Date() - new Date(currentEntry.doing_started_at)) / 1000)
          }

          const { data, error } = await supabase
            .from('drift_entries')
            .update({
              status: 'doing',
              doing_started_at: new Date().toISOString(),
              active_time_accumulated_seconds: accumulated,
              last_interaction_at: new Date().toISOString()
            })
            .eq('id', drift_id)
            .eq('user_id', user_id)
            .select()
            .single()
          
          if (error) {
            throw error
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(data))
        } 
        else if (action === 'done') {
          const { data: drift, error: selectError } = await supabase
            .from('drift_entries')
            .select('*')
            .eq('id', drift_id)
            .eq('user_id', user_id)
            .single()
          
          if (selectError) {
            throw selectError
          }

          const resolution_time_seconds = Math.floor(
            (new Date() - new Date(drift.created_at)) / 1000
          )
          
          let final_active_time = drift.active_time_accumulated_seconds || 0
          if (drift.status === 'doing' && drift.doing_started_at) {
            final_active_time += Math.floor(
              (new Date() - new Date(drift.doing_started_at)) / 1000
            )
          }
          
          const { data: swift, error: insertError } = await supabase
            .from('swift_entries')
            .insert({
              user_id: drift.user_id,
              drift_id: drift.id,
              text: drift.text,
              identity: drift.identity,
              category: drift.category,
              repetition_count: drift.repetition_count,
              created_at: drift.created_at,
              resolution_time_seconds,
              active_time_seconds: final_active_time,
              resolved_at: new Date().toISOString(),
              reflection: reflection || null
            })
            .select()
            .single()
          
          if (insertError) {
            throw insertError
          }
          
          const { error: deleteError } = await supabase
            .from('drift_entries')
            .delete()
            .eq('id', drift_id)
          
          if (deleteError) {
            throw deleteError
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(swift))
        }
        else if (action === 'delay') {
          const { data: currentEntry, error: selectError } = await supabase
            .from('drift_entries')
            .select('*')
            .eq('id', drift_id)
            .eq('user_id', user_id)
            .single()
          
          if (selectError) {
            throw selectError
          }

          let accumulated = currentEntry.active_time_accumulated_seconds || 0
          if (currentEntry.status === 'doing' && currentEntry.doing_started_at) {
            accumulated += Math.floor((new Date() - new Date(currentEntry.doing_started_at)) / 1000)
          }

          const { data, error } = await supabase
            .from('drift_entries')
            .update({
              status: 'delayed',
              doing_started_at: null,
              active_time_accumulated_seconds: accumulated,
              last_interaction_at: new Date().toISOString()
            })
            .eq('id', drift_id)
            .eq('user_id', user_id)
            .select()
            .single()
          
          if (error) {
            throw error
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(data))
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid action. Use: doing, done, or delay' }))
        }
      } catch (error) {
        console.error('Update status error:', error)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: error.message }))
      }
    })
    return
  }

  if (parsedUrl.pathname === '/swift' && req.method === 'GET') {
    try {
      const { user_id } = parsedUrl.query
      
      if (!user_id) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing user_id parameter' }))
        return
      }

      const { data, error } = await supabase
        .from('swift_entries')
        .select('*')
        .eq('user_id', user_id)
        .order('resolved_at', { ascending: false })
        .limit(50)
      
      if (error) {
        throw error
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data || []))
    } catch (error) {
      console.error('Get swift error:', error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: error.message }))
    }
    return
  }

  if (parsedUrl.pathname === '/realms' && req.method === 'GET') {
    try {
      const { user_id } = parsedUrl.query
      
      if (!user_id) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing user_id parameter' }))
        return
      }

      const { data: driftData, error: driftError } = await supabase
        .from('drift_entries')
        .select('category, repetition_count')
        .eq('user_id', user_id)

      if (driftError) {
        throw driftError
      }

      const categories = ['Relationships', 'Work', 'Finance', 'Health', 'Self']
      
      const heatScores = categories.map(category => {
        const driftEntries = (driftData || []).filter(entry => entry.category === category)
        
        const A = driftEntries.length
        
        const R = A > 0 
          ? driftEntries.reduce((sum, entry) => sum + entry.repetition_count, 0) / A 
          : 0
        
        const S = A > 0 
          ? driftEntries.filter(entry => entry.repetition_count >= 3).length / A 
          : 0
        
        const heat = (A * 0.5) + (R * 0.3) + (S * 0.2)
        
        return {
          category,
          friction_score: Math.round(heat * 100) / 100,
          drift_count: A,
          avg_repetitions: Math.round(R * 10) / 10,
          stickiness_rate: Math.round(S * 100) / 100
        }
      })
      
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(heatScores))
    } catch (error) {
      console.error('Get realms error:', error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: error.message }))
    }
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Route not found' }))
})

const PORT = process.env.PORT || 3000
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Drift Log API running on port ${PORT}`)
})
