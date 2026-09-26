-- Match the leader photo bucket limit to the 8 MB upload form limit.
update storage.buckets
set file_size_limit = 8388608
where id = 'leader-photos';