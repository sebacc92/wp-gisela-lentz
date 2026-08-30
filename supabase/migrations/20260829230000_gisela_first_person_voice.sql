-- El número es el de Gisela y es ella quien contesta. Los mensajes automáticos
-- hablaban de ella en tercera persona ("Gisela lo va a revisar"), como si del
-- otro lado hubiera una recepción aparte. Pasan a primera persona.
--
-- Sólo cambian textos: ninguna regla de agenda, seña ni disponibilidad.
update public.app_settings
set
  automation_welcome_message =
    E'¡Hola! 👋 Soy Gisela.\n\nPor acá podés sacar un turno, reprogramarlo, cancelarlo o consultar los que ya tenés.\n\nSi es una urgencia o preferís contarme algo puntual, escribime y te respondo.',
  urgent_message =
    'Tomo tu mensaje como urgencia y te respondo apenas lo vea, para darte un turno lo antes posible. Las urgencias las atiendo de forma particular y tienen un valor diferente. Si es una emergencia grave, acercate a una guardia.',
  general_info_message =
    E'Mi consultorio está en calle 11 N° 1375, entre 26 y 28, Miramar, Provincia de Buenos Aires.\n\nAtiendo con turno: lunes de 9:30 a 15, martes de 13:30 a 17, miércoles de 9:30 a 12 y de 16 a 21, jueves de 10 a 15 y viernes de 9:30 a 11. Los feriados nacionales el consultorio permanece cerrado.\n\nEscribime siempre por acá, este WhatsApp.',
  out_of_hours_message =
    'Gracias por escribirme. Ahora estoy fuera del horario de atención, pero leo tu mensaje y te respondo cuando vuelva.',
  deposit_request_message_template =
    E'¡Hola! 😊\n\nPara confirmar tu turno te pido una seña de {deposit_amount}.\n\nLa descuento del valor de la consulta el día del turno. Es para asegurar el lugar y evitar ausencias.\n\nDatos para transferir:\n\nAlias: {deposit_alias}\n\nTitular: {deposit_holder}\n\nQuedo atenta al comprobante. ¡Gracias! 💛✨',
  -- La segunda oración decía "Gisela lo va a revisar y te confirmaremos el
  -- turno". Sale: quien recibe el comprobante es ella misma.
  deposit_proof_received_message_template =
    E'¡Gracias! 😊 Recibí tu comprobante.',
  deposit_confirmed_message_template =
    E'¡Listo! 😊 Tu turno quedó confirmado.\n\nTe espero el {date} a las {time}.\n\n¡Gracias! 💛',
  booking_hold_expired_message_template =
    E'El horario que te había reservado quedó nuevamente disponible porque no me llegó el comprobante dentro del tiempo previsto.\n\nSi querés, te busco otro horario 😊'
where id = true;
