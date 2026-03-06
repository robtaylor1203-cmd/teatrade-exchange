// script to update profile and wipe chat
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !supabaseKey) {
    console.error("Missing SUPABASE vars");
    Deno.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
    console.log("Fetching trader_joe profile...");
    const { data: profile, error: fetchErr } = await supabase
        .from("profiles")
        .select("id")
        .eq("username", "trader_joe")
        .single();

    if (fetchErr || !profile) {
        console.error("Error finding trader_joe:", fetchErr);
    } else {
        console.log("Found trader_joe:", profile.id);

        console.log("Updating username to 'TeaTrade Admin'...");
        const { error: updateErr } = await supabase
            .from("profiles")
            .update({ username: "TeaTrade Admin" })
            .eq("id", profile.id);

        if (updateErr) console.error("Update error:", updateErr);
        else console.log("Profile updated.");

        console.log("Removing followers...");
        const { error: followErr } = await supabase
            .from("followers")
            .delete()
            .eq("following_id", profile.id);

        if (followErr) console.error("Follower delete error:", followErr);
        else console.log("Followers removed.");
    }

    console.log("Wiping global chat...");
    const { error: chatErr } = await supabase
        .from("chat_messages")
        .delete()
        .neq("id", "00000000-0000-0000-0000-000000000000"); // deletes all rows

    if (chatErr) console.error("Chat delete error:", chatErr);
    else console.log("Global chat wiped.");

    console.log("Done.");
}

run();
