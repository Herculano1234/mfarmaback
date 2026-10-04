export const validate = (schema, source = 'body') => (req, _res, next) => {
  const parsed = schema.parse(req[source]);
  if (source === 'query') req.validatedQuery = parsed;
  else req[source] = parsed;
  next();
};
