-- 在 Supabase SQL Editor 中执行一次。
-- 作用：把 KISS-Translator 生词合并到 TypeWords 的独立词典「KISS 生词本」（id/enName = 'kiss-words'）。
-- 幂等：重复执行/调用不会产生重复词；词典不存在时自动创建。

create or replace function merge_kiss_words(p_words jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_data     jsonb;
  v_booklist jsonb;
  v_idx      int := -1;
  v_words    jsonb;
  v_word     jsonb;
  v_key      text;
  v_norm     text;
  v_added    int := 0;
  v_skipped  int := 0;
  v_dict     jsonb;
  v_existing text[] := '{}';
  v_dirty    bool := false;
  v_created  bool := false;
begin
  select data into v_data from typewords_data where type = 'dict';
  if v_data is null or v_data = 'null'::jsonb then
    return jsonb_build_object('ok', false, 'reason', 'dict row missing');
  end if;

  if v_data ? 'word' and v_data->'word' ? 'bookList' then
    v_booklist := v_data #> '{word,bookList}';
  else
    v_booklist := '[]'::jsonb;
  end if;

  -- 1. 定位 KISS 生词本词典（id/enName = 'kiss-words'）
  for i in 0 .. jsonb_array_length(v_booklist) - 1 loop
    v_dict := v_booklist -> i;
    if coalesce(v_dict->>'id','') = 'kiss-words'
       or coalesce(v_dict->>'enName','') = 'kiss-words' then
      v_idx := i;
      exit;
    end if;
  end loop;

  -- 2. 不存在则创建自定义词典。
  --    custom=true 是关键：TypeWords 保存时 shakeCommonDict 只保留 custom/system 词典的 words，
  --    否则下次保存会把生词清空。
  if v_idx < 0 then
    v_booklist := v_booklist || jsonb_build_array(jsonb_build_object(
      'id', 'kiss-words',
      'enName', 'kiss-words',
      'name', 'KISS 生词本',
      'description', '来自 KISS-Translator 的生词',
      'url', '',
      'length', 0,
      'category', '',
      'tags', '[]'::jsonb,
      'translateLanguage', '',
      'type', 'word',
      'language', 'en',
      'lastLearnIndex', 0,
      'perDayStudyNumber', 20,
      'custom', true,
      'system', false,
      'sourceId', '',
      'complete', false,
      'createdBy', '',
      'category_id', null,
      'is_default', false,
      'update', false,
      'cover', '',
      'sync', false,
      'words', '[]'::jsonb,
      'articles', '[]'::jsonb,
      'statistics', '[]'::jsonb
    ));
    v_idx := jsonb_array_length(v_booklist) - 1;
    v_data := jsonb_set(v_data, array['word','bookList'], v_booklist);
    v_dirty := true;
    v_created := true;
  end if;

  -- 3. 合并生词（小写去重）
  v_words := coalesce(v_data #> array['word','bookList', v_idx::text, 'words'], '[]'::jsonb);
  v_existing := array(select lower(coalesce(w->>'word','')) from jsonb_array_elements(v_words) w);

  for v_word in select value from jsonb_array_elements(p_words) loop
    v_key := v_word ->> 'word';
    if v_key is null or v_key = '' then continue; end if;
    v_norm := lower(v_key);
    if v_norm = any(v_existing) then
      v_skipped := v_skipped + 1;
    else
      v_words := v_words || jsonb_build_array(v_word);
      v_existing := v_existing || v_norm;
      v_added := v_added + 1;
    end if;
  end loop;

  if v_added > 0 then
    v_data := jsonb_set(v_data, array['word','bookList', v_idx::text, 'words'], v_words);
    v_data := jsonb_set(v_data, array['word','bookList', v_idx::text, 'length'],
                        to_jsonb(jsonb_array_length(v_words)));
    v_dirty := true;
  end if;

  if not v_dirty then
    return jsonb_build_object('ok', true, 'added', 0, 'skipped', v_skipped, 'created', false);
  end if;

  update typewords_data
     set data         = v_data,
         data_version = coalesce(data_version, 4),
         updated_at   = now()
   where type = 'dict';

  return jsonb_build_object('ok', true, 'added', v_added, 'skipped', v_skipped, 'created', v_created);
end;
$$;

-- 允许 worker 使用的角色调用（service_role 默认也可执行，这里显式授权给 anon/authenticated 以防万一）
grant execute on function merge_kiss_words(jsonb) to anon, authenticated;
