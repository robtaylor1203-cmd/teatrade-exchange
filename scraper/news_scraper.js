require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const Parser = require('rss-parser');
const parser = new Parser();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

async function extractNewsWithLLM(title, snippet) {
    const prompt = `
You are an expert commodity market analyst. Analyze the following news headline and snippet about the tea market.
Return ONLY a strictly formatted JSON object that matches the following schema.

Schema:
{
  "sentiment": "string (strictly one of: 'bullish', 'bearish', or 'neutral')",
  "snippet": "string (a concise, punchy 1-2 sentence summary of the news)",
  "tags": ["array", "of", "3", "to", "4", "relevant", "keywords", "like", "Bullish", "Sri Lanka", "Supply"],
  "impacts": [
    { "type": "string (strictly 'bull', 'bear', or 'neut')", "text": "string (a short 1-sentence explanation of this impact. e.g. '<strong>Positive:</strong> Price action suggests continued momentum.')" },
    ... provide 2 to 3 impact objects
  ]
}

News Title:
${title}

News Snippet:
${snippet}
`;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" },
            temperature: 0.1,
        });
        return JSON.parse(response.choices[0].message.content);
    } catch (e) {
        console.error("OpenAI processing failed:", e.message);

        // --- FALLBACK LOGIC IF QUOTA EXCEEDED ---
        console.log("Using rule-based fallback logic instead of AI.");
        const textToAnalyze = (title + " " + snippet).toLowerCase();

        let sentiment = "neutral";
        if (textToAnalyze.includes("surge") || textToAnalyze.includes("high") || textToAnalyze.includes("demand") || textToAnalyze.includes("bullish") || textToAnalyze.includes("growth")) {
            sentiment = "bullish";
        } else if (textToAnalyze.includes("drop") || textToAnalyze.includes("low") || textToAnalyze.includes("fall") || textToAnalyze.includes("bearish") || textToAnalyze.includes("loss")) {
            sentiment = "bearish";
        }

        return {
            sentiment: sentiment,
            snippet: snippet.substring(0, 150) + "...",
            tags: ["Tea Market", "Commodities", "News"],
            impacts: [
                { type: sentiment === "bullish" ? "bull" : sentiment === "bearish" ? "bear" : "neut", text: "<strong>Market Impact:</strong> Keep an eye on price action following this release." }
            ]
        };
    }
}

async function scrapeNews() {
    console.log("Fetching Google News RSS for Tea Commodities...");
    const RSS_URL = "https://news.google.com/rss/search?q=tea+commodity+market+OR+tea+auction+OR+tea+prices+when:7d&hl=en-US&gl=US&ceid=US:en";

    let feed;
    try {
        feed = await parser.parseURL(RSS_URL);
    } catch (e) {
        console.error("Failed to parse RSS feed:", e.message);
        return;
    }

    console.log(`Found ${feed.items.length} news articles.`);

    // We only want to process up to 5 articles per run to save AI tokens and prevent spam
    const maxItems = Math.min(feed.items.length, 5);

    for (let i = 0; i < maxItems; i++) {
        const item = feed.items[i];

        // Use the title without the publisher suffix if present (Google News format "Title - Publisher")
        const cleanTitle = item.title.split(' - ').slice(0, -1).join(' - ') || item.title;
        // Strip HTML from content snippet
        const cleanSnippet = (item.contentSnippet || item.content || "").replace(/(<([^>]+)>)/gi, "");
        const pubDate = new Date(item.pubDate).toISOString();
        const url = item.link;

        // Check if article already exists via URL
        const { data: existing } = await supabase.from('news').select('id').eq('url', url).maybeSingle();
        if (existing) {
            console.log(`Skipping duplicate: ${cleanTitle}`);
            continue;
        }

        console.log(`Processing: ${cleanTitle}`);

        const aiData = await extractNewsWithLLM(cleanTitle, cleanSnippet);

        if (aiData) {
            const row = {
                title: cleanTitle,
                snippet: aiData.snippet,
                sentiment: aiData.sentiment,
                tags: aiData.tags,
                impacts: aiData.impacts,
                published_at: pubDate,
                url: url
            };

            const { error } = await supabase.from('news').insert([row]);
            if (error) {
                console.error(`Failed to insert ${cleanTitle}:`, error.message);
            } else {
                console.log(`Inserted successfully: ${cleanTitle}`);
            }
        }
    }
    console.log("News scraping complete.");
}

scrapeNews().catch(err => {
    console.error("Fatal exception in scraper:", err);
    process.exit(1);
});
